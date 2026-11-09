// Offline replay only: no Electron, model, credential store, network or package.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const repo = process.cwd(), root = process.env.BLINKY_RESULT_REPLAY_ROOT
assert.ok(root, 'Use an explicit fresh directory in this task workspace')
assert.ok(!await fs.stat(root).catch(() => null), 'Do not overwrite previous evidence')
await fs.mkdir(root, { recursive: true })
const product = path.resolve(process.env.BLINKY_RESULT_PRODUCT_ROOT || repo)
process.env.OPENBOT_DATA_DIR = path.join(root, 'isolated-app-data')
globalThis.__resultReplayData = process.env.OPENBOT_DATA_DIR
const built = await build({
  stdin: { contents: `export {codexNotification,CodexItems} from './src/main/backends/cli/codexEvents.ts'; export {executionObservations} from './src/main/tasks/executionObservations.ts'`, resolveDir: product, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'no-electron-or-keychain', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app={getPath:()=>globalThis.__resultReplayData};export const safeStorage={isEncryptionAvailable:()=>false}', loader: 'js' }))
  } }]
})
const { codexNotification, CodexItems, executionObservations } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`)
const operation = path.join(repo, 'Scripts/fixtures/planning-result-operation.cjs')
const worker = path.join(repo, 'Scripts/fixtures/planning-result-worker.cjs')
const { contract } = createRequire(import.meta.url)(operation)
const recordedState = process.env.BLINKY_RESULT_RECORDED_STATE || path.resolve(repo, 'Scripts/fixtures/planning-result-recorded.json')
const previous = JSON.parse(await fs.readFile(recordedState, 'utf8'))
const original = previous.events.find(e => e.type === 'tool-call' && e.call.name === 'delegate_task' && !e.call.args.continue_task_id).call.args
const results = []

async function replay(name, prompt, context) {
  const dir = path.join(root, name), work = path.join(dir, 'work'), data = path.join(dir, 'data')
  for (const d of [work, path.join(data, 'tasks'), path.join(dir, 'home'), path.join(dir, 'tmp')]) await fs.mkdir(d, { recursive: true })
  const control = path.join(dir, 'control.json'), trace = path.join(dir, 'worker.jsonl'), launcher = path.join(dir, 'launcher.cjs')
  const cfg = { root: dir, data, control, trace, operation, node: process.execPath }
  await fs.writeFile(control, JSON.stringify({ task: true })); await fs.writeFile(trace, '')
  await fs.writeFile(path.join(data, 'tasks/task.json'), JSON.stringify({ id: 'task', title: original.title, prompt, status: 'running', workspace: { path: work }, plan: { context } }))
  await fs.writeFile(launcher, 'globalThis.__planningResultFixture=' + JSON.stringify(cfg) + ';require(' + JSON.stringify(worker) + ')\n')
  const child = spawn(process.execPath, [launcher, 'app-server'], { cwd: work, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = '', stderr = ''
  const packets = []; child.stderr.on('data', b => { stderr += b })
  child.stdout.on('data', b => { buffer += b; for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; packets.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1) } })
  child.stdin.write(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'thread' } }) + '\n')
  try {
    const end = Date.now() + 10000
    while (!packets.some(p => p.method === 'turn/completed') && child.exitCode === null && Date.now() < end) await delay(20)
    assert.ok(packets.some(p => p.method === 'turn/completed'), stderr || 'Controlled fixture did not return')
  } finally { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]) }
  await fs.writeFile(path.join(dir, 'protocol.json'), JSON.stringify(packets, null, 2))
  return { dir, work, packets, trace: (await fs.readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) }
}

test('replay the actual r4 delegation with correct path, timezone, content and actual subprocess evidence', async () => {
  const run = await replay('positive-r4', original.prompt, original.plan.context)
  assert.equal(run.packets.find(p => p.method === 'turn/completed').params.turn.status, 'completed')
  const target = path.join(run.work, contract.relativePath), bytes = await fs.readFile(target), body = bytes.toString()
  assert.match(body, /仅用于合成任务流验收/); assert.equal(body.match(/^## /gm).length, 3)
  for (const value of [...contract.headings, ...contract.fields, contract.timeZone]) assert.ok(body.includes(value))
  assert.ok(!body.includes('Asia/Shanghai'))
  const operations = run.trace.filter(t => t.method === 'operation')
  assert.deepEqual(operations.map(t => [t.mode, t.exitCode]), [['write', 0], ['read', 0]])
  const receipt = run.trace.find(t => t.method === 'finish').receipt
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'))
  const items = new CodexItems(), traces = run.packets.flatMap(p => codexNotification(p.method, p.params, items, true)).filter(c => c.type === 'agent_trace').map(c => c.entry)
  const observations = executionObservations([{ id: 'executor-message', role: 'assistant', content: '', createdAt: 1, agentTrace: traces }], value => value)
  assert.equal(observations.length, 2)
  assert.ok(observations.every(v => v.state === 'completed' && v.origin === 'execution-trace'))
  await fs.writeFile(path.join(run.dir, 'production-observations.json'), JSON.stringify(observations, null, 2))
  results.push({ case: 'actual-r4-replay', ok: true, controlledProtocol: true, realNodeOperations: 2, realModelCalls: 0, actualAppLaunches: 0 })
})

test('the prior wrong timezone is rejected by independent readback, not accepted by a weaker assertion', async () => {
  const run = path.join(root, 'negative-timezone'), target = path.join(run, 'work', contract.relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, (await fs.readFile(path.join(root, 'positive-r4/work', contract.relativePath), 'utf8')).replaceAll('Asia/Singapore', 'Asia/Shanghai'))
  const result = spawnSync(process.execPath, [operation, 'read', run], { cwd: path.join(run, 'work'), env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  assert.equal(result.status, 1); assert.match(result.stderr, /actual file must meet/)
  results.push({ case: 'old-timezone-negative', ok: true, readbackExitCode: 1 })
})

test('a mismatching assignment does not execute or report a successful artifact', async () => {
  const run = await replay('mismatch', 'Use another scope and timezone', { scope: ['src/other'] })
  assert.equal(run.packets.find(p => p.method === 'turn/completed').params.turn.status, 'failed')
  assert.equal(run.trace.filter(t => t.method === 'operation').length, 0)
  assert.equal(await fs.stat(path.join(run.work, contract.relativePath)).catch(() => null), null)
  results.push({ case: 'mismatch-zero-operation', ok: true })
})

test('a workspace symlink cannot redirect the synthetic writer outside its assigned workspace', async () => {
  const dir = path.join(root, 'symlink'), work = path.join(dir, 'work'), other = path.join(dir, 'outside-work')
  await fs.mkdir(path.join(work, 'src'), { recursive: true }); await fs.mkdir(other, { recursive: true })
  await fs.symlink(other, path.join(work, 'src/export'))
  const result = spawnSync(process.execPath, [operation, 'write', dir], { cwd: work, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  assert.equal(result.status, 1); assert.match(result.stderr, /symlink must not escape/)
  assert.deepEqual(await fs.readdir(other), [])
  results.push({ case: 'symlink-escape-refused', ok: true })
  assert.equal(results.length, 4, 'All replay checks must pass before writing a success receipt')
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: true, cases: results, limits: ['offline controlled replay only', 'no real model or Electron result handling', 'frozen product parsers, not newest unified candidate'] }, null, 2))
})
