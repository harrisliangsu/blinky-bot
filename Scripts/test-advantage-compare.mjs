// Advantage comparison: does the BlinkyBot-mediated path (planner, delegation,
// progress tracking, structured reporting) beat raw `codex exec` on a
// multi-goal task? Both sides get the identical prompt and workspace; a
// per-goal acceptance grader plus a report-quality rubric score the results.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-advantage-compare.mjs
//
// Emits one JSON line per side, then a summary line. COMPARE_KEEP=1 keeps
// the workspace for inspection.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-adv-cmp-'))

// Fixture: a tiny calculator with a zero-multiply bug and a starter test file.
// Each side gets its own pristine copy so runs cannot pollute each other.
async function setupFixture(dir) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'math.js'), `// Tiny calculator module.
function add(a, b) { return a + b }
function subtract(a, b) { return a - b }
function multiply(a, b) {
  if (a === 0 || b === 0) { return NaN } // bug: any multiply by zero must return 0
  return a * b
 }
function divide(a, b) { if (b === 0) throw new Error('divide by zero'); return a / b }
module.exports = { add, subtract, multiply, divide }
`)
  await fs.writeFile(path.join(dir, 'calc.test.js'), `const { add, subtract, multiply, divide } = require('./math')
test('adds', () => { expect(add(2, 3)).toBe(5) })
test('subtracts', () => { expect(subtract(7, 2)).toBe(5) })
test('multiplies by zero', () => { expect(multiply(5, 0)).toBe(0) })
test('multiplies normally', () => { expect(multiply(3, 4)).toBe(12) })
`)
  return dir
}

const taskText = `在这个工作目录里完成三件事：1) 修复 math.js 里 multiply 的边界 bug——任何数乘以 0 必须返回 0（现有 calc.test.js 里已有测试会失败）；2) 新增 power(a, b) 指数函数并导出，b 为负数时必须抛 Error，并在 calc.test.js 里给 power 至少加 2 个测试；3) 新建 cli.js 和一个 README.md：cli.js 支持命令行四则运算和幂运算（如 node cli.js add 2 3 输出 5），参数不合法时打印用法并以非 0 退出码退出；README.md 说明模块用法、cli 用法以及如何运行测试。三件事全部做完后，运行测试确认全部通过。`

function runNode(script, cwd) {
  return new Promise((resolve) => execFile('node', ['-e', script], { cwd }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout + stderr })))
}

async function acceptance(ws) {
  const g1 = await runNode(`const m=require('./math');const assert=require('assert');assert.strictEqual(m.multiply(5,0),0);assert.strictEqual(m.multiply(0,7),0);assert.strictEqual(m.multiply(3,4),12);console.log('g1-ok')`, ws)
  const shim = `const assert=require('assert');globalThis.test=(n,f)=>{try{f();console.log('ok '+n)}catch(e){console.log('FAIL '+n+' '+e.message);process.exitCode=1}};globalThis.expect=(v)=>({toBe:(w)=>assert.strictEqual(v,w),toThrow:(cls)=>{let t=false;try{if(typeof v!=='function')assert.fail('expect(fn).toThrow');v()}catch(e){t=true;if(cls&&!(e instanceof cls))throw e}if(!t)assert.fail('expected throw')}});require('./calc.test.js')`
  const tests = await runNode(shim, ws)
  let powerTests = 0
  try { powerTests = (await fs.readFile(path.join(ws, 'calc.test.js'), 'utf8')).split(/test\(/).length - 1 - 4 } catch { powerTests = -1 }
  const g2 = await runNode(`const m=require('./math');const assert=require('assert');assert.strictEqual(m.power(2,10),1024);assert.strictEqual(m.power(3,0),1);let threw=false;try{m.power(2,-1)}catch(e){threw=true}assert.ok(threw);assert.ok(${powerTests}>=2,'power tests: ${powerTests}');console.log('g2-ok')`, ws)
  const cliAdd = await runNode(`console.log(require('child_process').execFileSync(process.execPath,['cli.js','add','2','3'],{stdio:'pipe'}).toString())`, ws)
  const cliBad = await new Promise((resolve) => execFile('node', ['cli.js', 'bogus'], { cwd: ws }, (error) => resolve({ ok: error !== null && (error.code ?? 1) !== 0 })))
  const readme = await fs.readFile(path.join(ws, 'README.md'), 'utf8').then((t) => ({ ok: /cli\.js/.test(t) && /test|测试/.test(t) })).catch(() => ({ ok: false }))
  const g3 = { ok: cliAdd.ok && /5/.test(cliAdd.stdout) && cliBad.ok && readme.ok, cliAdd: cliAdd.stdout.trim(), cliBad: cliBad.ok, readme: readme.ok }
  return {
    g1: g1.ok, g2: g2.ok, g3: g3.ok,
    testsOk: tests.ok && !tests.stdout.includes('FAIL'),
    testsTail: tests.stdout.trim().split('\n').slice(-4).join(' | '),
    powerTests, g3Detail: g3
  }
}

function gradeReport(text) {
  const t = String(text || '')
  const goals = ['multiply', 'power', 'cli'].filter((k) => t.toLowerCase().includes(k)).length
  const paths = (t.match(/[\w-]+\.(js|md)/g) || new Set()).length
  const testsMentioned = /通过|passed|pass|\d+\s*个测试|tests/i.test(t)
  const structured = /(^|\n)\s*[-1-9•*]/.test(t) || /\n\s*[-•*]/.test(t)
  return { goals, paths, testsMentioned, structured, score: goals + (paths >= 2 ? 1 : 0) + (testsMentioned ? 1 : 0) + (structured ? 1 : 0) }
}

async function runNative(ws) {
  const started = Date.now()
  let out = ''
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.HOME, '.local/bin/codex'), ['exec', taskText, '--sandbox', 'workspace-write', '--skip-git-repo-check'], { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => { out += d })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('codex exec exit ' + code + ' ' + err.slice(-300))))
  })
  return { wallMs: Date.now() - started, acceptance: await acceptance(ws), report: gradeReport(out.slice(-6000)), rawTail: out.slice(-500) }
}

async function runBlinkyb(ws) {
  const started = Date.now()
  const data = path.join(root, 'app-data-' + path.basename(ws)); await fs.mkdir(data)
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'default', memoryExtraction: 'off', backends: { codex: { enabled: true, command: path.join(process.env.HOME, '.local/bin/codex'), extraArgs: [] } } }))
  await fs.mkdir(path.join(data, 'bots'))
  await fs.writeFile(path.join(data, 'bots', 'dev.json'), JSON.stringify({ id: 'dev', name: 'Dev', description: '', systemPrompt: 'You are a careful coding assistant.', emoji: '✨', color: '#7c9cff', backendId: 'codex', modelId: 'default', followsDefault: false, tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell', 'fetch', 'todo_write', 'remember', 'handoff', 'delegate_task', 'request_help'], computerUse: false, computerTarget: { kind: 'local' }, executionAgent: { backendId: 'codex', modelId: 'default' }, createdAt: 1, updatedAt: 1 }))
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const child = spawn(electron, [repo, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { cwd: ws, env: { ...process.env, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'ignore'] })
  let wsock; const pending = new Map(); let seq = 0
  const cmd = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); wsock.send(JSON.stringify({ id, method: m, params: p })) }) }
  const evalJs = async (expression) => { const v = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error(v.exceptionDetails.text); return v.result.value }
  const wait = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return; await delay(200) } throw new Error('timeout: ' + expr.slice(0, 60)) }
  let targets; const end = Date.now() + 60000
  while (Date.now() < end) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break } catch { } await delay(100) }
  const page = targets.find((t) => t.type === 'page'); wsock = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { wsock.onopen = r; wsock.onerror = j })
  wsock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.rej(Error(JSON.stringify(m.error))) : x.res(m.result) } }
  const activityBefore = await evalJs(`(async()=>{try{return (await window.openbot.activity.list()).length}catch{return -1}})()`).catch(() => -1)
  try {
    await wait(`Boolean(document.querySelector('#ob-prompt'))`)
    const sid = await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];return b.activeConversationId})()`)
    await evalJs(`window.openbot.sessions.setCwd(${JSON.stringify(sid)},${JSON.stringify(ws)})`)
    await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,${JSON.stringify(taskText)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
    await wait(`(async()=>{const b=(await window.openbot.bots.list())[0];if(await window.openbot.agent.isRunning(b.activeConversationId))return false;try{const t=await window.openbot.tasks.list();return t.every((x)=>['completed','failed','cancelled'].includes(x.status))}catch{return true}})()`, 900000)
    await delay(3000)
    const transcript = await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];const s=await window.openbot.sessions.get(b.activeConversationId);return JSON.stringify((s&&s.messages)||[])})()`)
    await fs.writeFile(path.join(root, 'transcript.json'), transcript)
    const parsed = JSON.parse(transcript)
    const lastAssistant = String(parsed.filter((m) => m.role === 'assistant').slice(-1)[0]?.content || '')
    const activityAfter = await evalJs(`(async()=>{try{return (await window.openbot.activity.list()).length}catch{return -1}})()`).catch(() => -1)
    const tasksSeen = await evalJs(`(async()=>{try{const t=await window.openbot.tasks.list();return t.map(x=>({title:String(x.title||'').slice(0,40),status:x.status}))}catch{return []}})()`).catch(() => [])
    return { wallMs: Date.now() - started, acceptance: await acceptance(ws), report: gradeReport(lastAssistant), visibility: { activityDelta: activityAfter - activityBefore, assistantMessages: parsed.filter((m) => m.role === 'assistant').length, tasks: tasksSeen }, lastAssistant: lastAssistant.slice(0, 800) }
  } finally {
    child.kill('SIGTERM'); await delay(500); if (child.exitCode === null) child.kill('SIGKILL')
  }
}

const wsBlinkyb = await setupFixture(path.join(root, 'workspace-blinkybot'))
const wsNative = await setupFixture(path.join(root, 'workspace-native'))
const order = process.argv.includes('--native-first') ? [['native', wsNative], ['blinkybot', wsBlinkyb]] : [['blinkybot', wsBlinkyb], ['native', wsNative]]
const results = {}
for (const [mode, dir] of order) {
  const r = mode === 'native' ? await runNative(dir) : await runBlinkyb(dir)
  results[mode] = r
  console.log(JSON.stringify({ side: mode, ...r, lastAssistant: undefined, rawTail: undefined }))
}
const s = (r) => ['g1', 'g2', 'g3'].filter((g) => r.acceptance[g]).length
const summary = {
  goalsPassed: { blinkybot: s(results.blinkybot), native: s(results.native) },
  testsOk: { blinkybot: results.blinkybot.acceptance.testsOk, native: results.native.acceptance.testsOk },
  reportScore: { blinkybot: results.blinkybot.report.score, native: results.native.report.score, max: 6 },
  wallMs: { blinkybot: results.blinkybot.wallMs, native: results.native.wallMs },
  visibility: results.blinkybot.visibility || null
}
console.log(JSON.stringify({ summary }))
if (!process.env.COMPARE_KEEP) await fs.rm(root, { recursive: true, force: true })
else console.log('kept: ' + root)
