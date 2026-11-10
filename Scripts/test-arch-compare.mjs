// Architecture comparison matrix: BlinkyBot-mediated vs raw `codex exec`
// across scenarios that exercise different architectural claims.
//
//   A  multi-goal     ×3  acceptance / wallMs / report / visibility
//   B  multi-turn    ×2  round 2 revises "the second of the three things"
//   C  clarification ×2  hidden filename; bot can ask, native one-shot cannot
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-arch-compare.mjs
//
// Results stream as JSONL to stdout and append to /tmp/arch-compare.jsonl.
// COMPARE_KEEP=1 keeps workspaces.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWriteStream } from 'node:fs'

const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-arch-cmp-'))
const sink = createWriteStream('/tmp/arch-compare.jsonl', { flags: 'a' })
const emit = (obj) => { const line = JSON.stringify(obj); sink.write(line + '\n'); console.log(line) }

const REAL_BOT_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell', 'fetch', 'todo_write', 'remember', 'handoff', 'delegate_task', 'request_help']
const CODEX = path.join(process.env.HOME, '.local/bin/codex')

function runNode(script, cwd) {
  return new Promise((resolve) => execFile('node', ['-e', script], { cwd }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout + stderr })))
}

// ---------- fixtures ----------
async function fixtureA(dir) {
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
}

async function fixtureC(dir) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'report.js'), `// Prints a tiny daily summary to stdout.
const rows = [['apples', 12], ['pears', 7]]
for (const [name, n] of rows) console.log(name + ': ' + n)
`)
}

// ---------- prompts ----------
const PROMPT_A = `在这个工作目录里完成三件事：1) 修复 math.js 里 multiply 的边界 bug——任何数乘以 0 必须返回 0（现有 calc.test.js 里已有测试会失败）；2) 新增 power(a, b) 指数函数并导出，b 为负数时必须抛 Error，并在 calc.test.js 里给 power 至少加 2 个测试；3) 新建 cli.js 和一个 README.md：cli.js 支持命令行四则运算和幂运算（如 node cli.js add 2 3 输出 5），参数不合法时打印用法并以非 0 退出码退出；README.md 说明模块用法、cli 用法以及如何运行测试。三件事全部做完后，运行测试确认全部通过。`
const PROMPT_B2 = `刚才三件事里的第 2 件改一下：power 的 b 为负数时不要抛异常了，改成返回 NaN，测试也同步更新。其他两件事保持不变。`
const PROMPT_C1 = `帮我把 report.js 改成把结果写入一个文件而不是打印到屏幕，其他行为不要变。`
const PROMPT_C2 = `文件名用 daily_report.txt。`

// ---------- acceptance ----------
const SHIM = `const assert=require('assert');globalThis.test=(n,f)=>{try{f();console.log('ok '+n)}catch(e){console.log('FAIL '+n+' '+e.message);process.exitCode=1}};globalThis.expect=(v)=>({toBe:(w)=>assert.strictEqual(v,w),toThrow:(cls)=>{let t=false;try{if(typeof v!=='function')assert.fail('expect(fn).toThrow');v()}catch(e){t=true;if(cls&&!(e instanceof cls))throw e}if(!t)assert.fail('expected throw')}});require('./calc.test.js')`

async function acceptA(ws) {
  const g1 = await runNode(`const m=require('./math');const assert=require('assert');assert.strictEqual(m.multiply(5,0),0);assert.strictEqual(m.multiply(0,7),0);assert.strictEqual(m.multiply(3,4),12);console.log('g1-ok')`, ws)
  const g2 = await runNode(`const m=require('./math');const assert=require('assert');assert.strictEqual(m.power(2,10),1024);assert.strictEqual(m.power(3,0),1);let threw=false;try{m.power(2,-1)}catch(e){threw=true}assert.ok(threw);console.log('g2-ok')`, ws)
  const cliAdd = await runNode(`console.log(require('child_process').execFileSync(process.execPath,['cli.js','add','2','3'],{stdio:'pipe'}).toString())`, ws)
  const cliBad = await new Promise((resolve) => execFile('node', ['cli.js', 'bogus'], { cwd: ws }, (error) => resolve({ ok: error !== null && (error.code ?? 1) !== 0 })))
  const readme = await fs.readFile(path.join(ws, 'README.md'), 'utf8').then((t) => ({ ok: /cli\.js/.test(t) && /test|测试/.test(t) })).catch(() => ({ ok: false }))
  const tests = await runNode(SHIM, ws)
  return { g1: g1.ok, g2: g2.ok, g3: cliAdd.ok && /5/.test(cliAdd.stdout) && cliBad.ok && readme.ok, testsOk: tests.ok && !tests.stdout.includes('FAIL') }
}

async function acceptB2(ws) {
  const powerNaN = await runNode(`const m=require('./math');const assert=require('assert');assert.ok(Number.isNaN(m.power(2,-1)),'negative exponent must return NaN');let threw=false;try{m.power(2,-1)}catch(e){threw=true}assert.ok(!threw,'must not throw');assert.strictEqual(m.power(2,10),1024);console.log('b2-ok')`, ws)
  const g1 = await runNode(`const m=require('./math');const assert=require('assert');assert.strictEqual(m.multiply(5,0),0);assert.strictEqual(m.multiply(3,4),12);console.log('g1-ok')`, ws)
  const cli = await runNode(`console.log(require('child_process').execFileSync(process.execPath,['cli.js','power','2','10'],{stdio:'pipe'}).toString())`, ws)
  const tests = await runNode(SHIM, ws)
  return { revised: powerNaN.ok, g1Kept: g1.ok, g3Kept: cli.ok && /1024/.test(cli.stdout), testsOk: tests.ok && !tests.stdout.includes('FAIL') }
}

async function acceptC(ws, expectedFile) {
  const run = await runNode(`const {execFileSync}=require('child_process');const out=execFileSync(process.execPath,['report.js'],{stdio:'pipe'}).toString();fs.writeFileSync('/tmp/arch-c-stdout.txt',out);console.log('ran')`.replace('fs.writeFileSync', "require('fs').writeFileSync"), ws)
  const stdout = run.ok ? (await fs.readFile('/tmp/arch-c-stdout.txt', 'utf8').catch(() => '')) : 'run-failed'
  const exists = await fs.access(path.join(ws, expectedFile)).then(() => true).catch(() => false)
  const content = exists ? await fs.readFile(path.join(ws, expectedFile), 'utf8').catch(() => '') : ''
  return { correctFile: exists, stdoutQuiet: run.ok && stdout.trim() === '', contentOk: /apples/.test(content) && /12/.test(content) }
}

// ---------- report rubric ----------
function gradeReport(text) {
  const t = String(text || '')
  const goals = ['multiply', 'power', 'cli'].filter((k) => t.toLowerCase().includes(k)).length
  const paths = (t.match(/[\w-]+\.(js|md)/g) || new Set()).length
  const testsMentioned = /通过|passed|pass|\d+\s*个测试|tests/i.test(t)
  const structured = /(^|\n)\s*[-1-9•*]/.test(t) || /\n\s*[-•*]/.test(t)
  return { goals, paths, testsMentioned, structured, score: goals + (paths >= 2 ? 1 : 0) + (testsMentioned ? 1 : 0) + (structured ? 1 : 0) }
}

// ---------- native side ----------
async function nativeRun(ws, prompt) {
  const started = Date.now()
  let out = ''
  await new Promise((resolve, reject) => {
    const child = spawn(CODEX, ['exec', prompt, '--sandbox', 'workspace-write', '--skip-git-repo-check'], { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => { out += d })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('codex exec exit ' + code + ' ' + err.slice(-300))))
  })
  return { wallMs: Date.now() - started, output: out }
}

// ---------- blinkybot side ----------
async function botRun(ws, rounds, opts = {}) {
  const started = Date.now()
  const data = path.join(root, 'app-data-' + path.basename(ws) + '-' + String(rounds.length) + '-' + Math.random().toString(36).slice(2, 6))
  await fs.mkdir(data)
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'default', memoryExtraction: 'off', backends: { codex: { enabled: true, command: CODEX, extraArgs: [] } } }))
  await fs.mkdir(path.join(data, 'bots'))
  await fs.writeFile(path.join(data, 'bots', 'dev.json'), JSON.stringify({ id: 'dev', name: 'Dev', description: '', systemPrompt: 'You are a careful coding assistant.', emoji: '✨', color: '#7c9cff', backendId: 'codex', modelId: 'default', followsDefault: false, tools: REAL_BOT_TOOLS, computerUse: false, computerTarget: { kind: 'local' }, executionAgent: { backendId: 'codex', modelId: 'default' }, createdAt: 1, updatedAt: 1 }))
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const child = spawn(electron, [repo, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { cwd: ws, env: { ...process.env, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'ignore'] })
  let wsock; const pending = new Map(); let seq = 0
  const cmd = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); wsock.send(JSON.stringify({ id, method: m, params: p })) }) }
  const evalJs = async (expression) => { const v = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 300)); return v.result.value }
  const wait = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return; await delay(200) } throw new Error('timeout: ' + expr.slice(0, 60)) }
  let targets; const deadline = Date.now() + 60000
  while (Date.now() < deadline) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === 'page')) break } catch { } await delay(100) }
  const page = targets.find((t) => t.type === 'page'); wsock = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { wsock.onopen = r; wsock.onerror = j })
  wsock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.rej(Error(JSON.stringify(m.error))) : x.res(m.result) } }
  const activityBefore = await evalJs(`(async()=>{try{return (await window.openbot.activity.list()).length}catch{return -1}})()`).catch(() => -1)
  const idleExpr = `(async()=>{const b=(await window.openbot.bots.list())[0];if(!b)return false;if(await window.openbot.agent.isRunning(b.activeConversationId))return false;try{const t=await window.openbot.tasks.list();return t.every((x)=>['completed','failed','cancelled'].includes(x.status))}catch{return true}})()`
  const roundSummaries = []
  let clarificationsSeen = 0
  try {
    await wait(`Boolean(document.querySelector('#ob-prompt'))`)
    const sid = await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];return b.activeConversationId})()`)
    await evalJs(`window.openbot.sessions.setCwd(${JSON.stringify(sid)},${JSON.stringify(ws)})`)
    for (let i = 0; i < rounds.length; i++) {
      const t0 = Date.now()
      await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,${JSON.stringify(rounds[i])});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
      // Clarification watch: while waiting, answer any waiting_user clarification.
      const watchEnd = Date.now() + (opts.roundTimeoutMs ?? 900000)
      let answered = 0
      while (Date.now() < watchEnd) {
        if (await evalJs(idleExpr)) break
        const waiting = await evalJs(`(async()=>{try{const cs=await window.openbot.tasks.clarifications(null);const list=cs.clarifications||cs||[];return list.filter(c=>c.status==='waiting_user').map(c=>({clarificationId:c.id,taskId:c.taskId,questions:(c.questions||[]).map(q=>({id:q.id,question:q.question,kind:q.kind,options:(q.options||[]).map(o=>o.label)}))}))}catch(e){return []}})()`).catch(() => [])
        for (const c of waiting) {
          clarificationsSeen++
          const answers = {}
          for (const q of c.questions) answers[q.id] = [opts.clarificationAnswer || 'daily_report.txt']
          const ok = await evalJs(`(async()=>{try{await window.openbot.tasks.answerClarification(${JSON.stringify(c.clarificationId)},${JSON.stringify(answers)});return true}catch(e){return 'ERR '+String(e).slice(0,200)}})()`)
          if (ok === true) answered++
          else emit({ scenario: opts.scenario, side: 'blinkybot', warn: 'answerClarification failed', detail: ok, questions: c.questions })
        }
        await delay(2000)
      }
      await delay(3000)
      const transcript = JSON.parse(await evalJs(`(async()=>{const b=(await window.openbot.bots.list())[0];const s=await window.openbot.sessions.get(b.activeConversationId);return JSON.stringify((s&&s.messages)||[])})()`))
      const visible = transcript.filter((m) => m.role === 'assistant' && !m.internal)
      roundSummaries.push({ round: i + 1, wallMs: Date.now() - t0, assistantTotal: transcript.filter((m) => m.role === 'assistant').length, assistantVisible: visible.length, lastVisible: String(visible.slice(-1)[0]?.content || '').slice(0, 1200), clarificationsAnswered: answered })
    }
    const activityAfter = await evalJs(`(async()=>{try{return (await window.openbot.activity.list()).length}catch{return -1}})()`).catch(() => -1)
    const tasksSeen = await evalJs(`(async()=>{try{const t=await window.openbot.tasks.list();return t.map(x=>({title:String(x.title||'').slice(0,40),status:x.status}))}catch{return []}})()`).catch(() => [])
    return { wallMs: Date.now() - started, rounds: roundSummaries, visibility: { activityDelta: activityAfter - activityBefore, tasks: tasksSeen, clarificationsSeen }, dataDir: data }
  } finally {
    child.kill('SIGTERM'); await delay(500); if (child.exitCode === null) child.kill('SIGKILL')
  }
}

// ---------- matrix ----------
const repsA = Number(process.env.REPS_A ?? 3)
const repsB = Number(process.env.REPS_B ?? 2)
const repsC = Number(process.env.REPS_C ?? 2)
const only = process.env.ONLY // 'A' | 'B' | 'C'

for (let r = 1; r <= repsA && (!only || only === 'A'); r++) {
  const tag = 'A' + r
  try {
    const wsB = path.join(root, 'ws-' + tag + '-bot'); await fixtureA(wsB)
    const bot = await botRun(wsB, [PROMPT_A], { scenario: tag })
    const acc = await acceptA(wsB)
    const rep = gradeReport(bot.rounds[0].lastVisible)
    emit({ scenario: tag, side: 'blinkybot', wallMs: bot.wallMs, acceptance: acc, report: rep, visibility: bot.visibility })
  } catch (e) { emit({ scenario: tag, side: 'blinkybot', error: String(e).slice(0, 400) }) }
  try {
    const wsN = path.join(root, 'ws-' + tag + '-native'); await fixtureA(wsN)
    const nat = await nativeRun(wsN, PROMPT_A)
    const acc = await acceptA(wsN)
    const rep = gradeReport(nat.output.slice(-6000))
    emit({ scenario: tag, side: 'native', wallMs: nat.wallMs, acceptance: acc, report: rep })
  } catch (e) { emit({ scenario: tag, side: 'native', error: String(e).slice(0, 400) }) }
}

for (let r = 1; r <= repsB && (!only || only === 'B'); r++) {
  const tag = 'B' + r
  try {
    const wsB = path.join(root, 'ws-' + tag + '-bot'); await fixtureA(wsB)
    const bot = await botRun(wsB, [PROMPT_A, PROMPT_B2], { scenario: tag })
    const acc = await acceptB2(wsB)
    emit({ scenario: tag, side: 'blinkybot', wallMs: bot.wallMs, round2: acc, rounds: bot.rounds.map((x) => ({ round: x.round, wallMs: x.wallMs, assistantVisible: x.assistantVisible })), visibility: bot.visibility })
  } catch (e) { emit({ scenario: tag, side: 'blinkybot', error: String(e).slice(0, 400) }) }
  try {
    const wsN = path.join(root, 'ws-' + tag + '-native'); await fixtureA(wsN)
    const n1 = await nativeRun(wsN, PROMPT_A)
    const t2 = Date.now()
    const n2 = await nativeRun(wsN, PROMPT_B2)
    const acc = await acceptB2(wsN)
    emit({ scenario: tag, side: 'native', wallMs: n1.wallMs + n2.wallMs, round1Ms: n1.wallMs, round2Ms: Date.now() - t2, round2: acc })
  } catch (e) { emit({ scenario: tag, side: 'native', error: String(e).slice(0, 400) }) }
}

for (let r = 1; r <= repsC && (!only || only === 'C'); r++) {
  const tag = 'C' + r
  try {
    const wsB = path.join(root, 'ws-' + tag + '-bot'); await fixtureC(wsB)
    const bot = await botRun(wsB, [PROMPT_C1, PROMPT_C2], { scenario: tag, clarificationAnswer: 'daily_report.txt', roundTimeoutMs: 600000 })
    const filesAtRunEnd = (await fs.readdir(wsB)).filter((f) => f !== 'report.js')
    const acc = await acceptC(wsB, 'daily_report.txt')
    const filesCreated = (await fs.readdir(wsB)).filter((f) => f !== 'report.js')
    const reportJs = await fs.readFile(path.join(wsB, 'report.js'), 'utf8').catch(() => '')
    const askedInChat = /\?|？|哪[个个一]|请问|澄清/.test(bot.rounds[0]?.lastVisible || '')
    emit({ scenario: tag, side: 'blinkybot', wallMs: bot.wallMs, acceptance: acc, askedInChat, filesAtRunEnd, filesCreated, reportJsTail: reportJs.slice(-400), visibility: bot.visibility, rounds: bot.rounds.map((x) => ({ wallMs: x.wallMs, clarificationsAnswered: x.clarificationsAnswered, lastVisible: x.lastVisible.slice(0, 400) })) })
  } catch (e) { emit({ scenario: tag, side: 'blinkybot', error: String(e).slice(0, 400) }) }
  try {
    const wsN = path.join(root, 'ws-' + tag + '-native'); await fixtureC(wsN)
    const nat = await nativeRun(wsN, PROMPT_C1)
    const acc = await acceptC(wsN, 'daily_report.txt')
    // Also record which filename native picked, if any.
    const files = (await fs.readdir(wsN)).filter((f) => f !== 'report.js')
    emit({ scenario: tag, side: 'native', wallMs: nat.wallMs, acceptance: acc, filesCreated: files })
  } catch (e) { emit({ scenario: tag, side: 'native', error: String(e).slice(0, 400) }) }
}

emit({ scenario: 'done', root })
if (!process.env.COMPARE_KEEP) await fs.rm(root, { recursive: true, force: true })
sink.end()
