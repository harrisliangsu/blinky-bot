// Chat regression comparison: BlinkyBot-mediated execution vs the raw CLI agent
// on identical small tasks with objective acceptance checks.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-execution-compare.mjs [--native]
//
// Without --native it drives the app harness (real Codex, governed runtime) in
// a fresh workspace; with --native it shells out to `codex exec` in the same
// workspace shape. Acceptance scripts then grade both impartially.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-exec-cmp-'))
const ws = path.join(root, 'workspace')
await fs.mkdir(ws, { recursive: true })

// Fixture: a tiny JS module with a deliberate bug and a partial test suite.
await fs.writeFile(path.join(ws, 'calc.js'), `// Small calculator module.
function add(a, b) { return a + b }
function subtract(a, b) { return b - a } // bug: reversed operands
module.exports = { add, subtract }
`)
await fs.writeFile(path.join(ws, 'calc.test.js'), `const { add, subtract } = require('./calc')
test('adds', () => { expect(add(2, 3)).toBe(5) })
test('subtracts in argument order', () => { expect(subtract(7, 2)).toBe(5) })
`)

const taskText = `在这个工作目录里完成两件事：1) 修复 calc.js 里 subtract 的操作数顺序 bug（subtract(7,2) 必须等于 5）；2) 补充 multiply 和 divide 两个函数（divide 除以 0 时抛 Error），并在 calc.test.js 里给 multiply 和 divide 各加至少两个测试。完成后运行测试确认全部通过。`

// Acceptance: run the Jest suite; every test must pass, and the module must export multiply/divide.
async function acceptance() {
  const check = await new Promise((resolve) => {
    execFile('node', ['-e', `const c=require('${ws}/calc');const assert=require('assert');assert.strictEqual(c.subtract(7,2),5);assert.strictEqual(c.multiply(3,4),12);assert.strictEqual(c.divide(8,2),4);let threw=false;try{c.divide(1,0)}catch{threw=true}assert.ok(threw);console.log('module-ok')`], (error, stdout) => resolve({ ok: !error && stdout.includes('module-ok'), error: String(error) }))
  })
  const shim = `const assert=require('assert');globalThis.test=(n,f)=>{try{f();console.log('ok '+n)}catch(e){console.log('FAIL '+n+' '+e.message);process.exitCode=1}};globalThis.expect=(v)=>({toBe:(w)=>assert.strictEqual(v,w),toEqual:(w)=>assert.deepStrictEqual(v,w),toBeCloseTo:(w,p=2)=>assert.ok(Math.abs(v-w)<Math.pow(10,-p)/2,v+' not close to '+w),toThrow:(cls)=>{let t=false;try{if(typeof v!=='function')assert.fail('expect(fn).toThrow');v()}catch(e){t=true;if(cls&&!(e instanceof cls))throw e}if(!t)assert.fail('expected throw')}});require('./calc.test.js')`
  const tests = await new Promise((resolve) => {
    execFile('node', ['-e', shim], { cwd: ws }, (error, stdout) => resolve({ ok: !error && !stdout.includes('FAIL'), tail: stdout.slice(-300) }))
  })
  return { moduleOk: check.ok, testsOk: tests.ok, testsTail: tests.tail }
}

const mode = process.argv.includes('--native') ? 'native' : 'blinkybot'
const started = Date.now()
let acceptanceResult

if (mode === 'native') {
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.HOME, '.local/bin/codex'), ['exec', taskText, '--sandbox', 'workspace-write', '--skip-git-repo-check'], { cwd: ws, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('codex exec exit ' + code + ' ' + err.slice(-300))))
  })
  acceptanceResult = await acceptance()
} else {
  const data = path.join(root, 'app-data'); await fs.mkdir(data)
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'default', memoryExtraction: 'off', backends: { codex: { enabled: true, command: path.join(process.env.HOME, '.local/bin/codex'), extraArgs: [] } } }))
  await fs.mkdir(path.join(data, 'bots'))
  await fs.writeFile(path.join(data, 'bots', 'dev.json'), JSON.stringify({ id: 'dev', name: 'Dev', description: '', systemPrompt: 'You are a careful coding assistant.', emoji: '✨', color: '#7c9cff', backendId: 'codex', modelId: 'default', followsDefault: false, tools: [], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 }))
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
  try {
    await wait(`Boolean(document.querySelector('#ob-prompt'))`)
    const sid = await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];return b.activeConversationId})()`)
    await evalJs(`window.openbot.sessions.setCwd(${JSON.stringify(sid)},${JSON.stringify(ws)})`)
    await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,${JSON.stringify(taskText)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
    await wait(`(async()=>{const b=(await window.openbot.bots.list())[0];return !(await window.openbot.agent.isRunning(b.activeConversationId))})()`, 600000)
    await delay(1000)
    const transcript = await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];const s=await window.openbot.sessions.get(b.activeConversationId);return JSON.stringify((s&&s.messages)||[])})()`)
    await fs.writeFile(path.join(root, 'transcript.json'), transcript)
    const parsed = JSON.parse(transcript)
    const tail = parsed.filter((m) => m.role === 'assistant').slice(-2).map((m) => String(m.content || '').slice(0, 600))
    console.log(JSON.stringify({ transcript: tail }))
  } finally {
    child.kill('SIGTERM'); await delay(500); if (child.exitCode === null) child.kill('SIGKILL')
  }
  acceptanceResult = await acceptance()
}

const result = { mode, wallMs: Date.now() - started, ...acceptanceResult }
console.log(JSON.stringify({ ok: true, ...result }))
if (!process.env.COMPARE_KEEP) await fs.rm(root, { recursive: true, force: true })
else console.log('kept: ' + root)
