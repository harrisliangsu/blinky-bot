import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Real task orchestration, SQLite sessions and durable JSON. Only the model,
// queue-runtime and Electron fan-out are replaced; no app, account or GUI runs.
const root = await mkdtemp(join(tmpdir(), 'blinky-task-runtime-'))
const previous = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
globalThis.__taskRuntime = { events: [], send: async () => {}, receive: async () => false, stopped: [] }
const mocks = {
  './tasks/progressTurn':`export const taskJudgmentStatus=async()=>null`,
  './tasks/coordinationPermission':`export const communicationPermissionStatus=async()=>null`,
  '../agent/backendGateway': 'export const getBackend=async()=>null;export const runSideCall=async()=>{throw Error("Unexpected inference in task orchestration fixture")}',
  '../ipc/broadcast': 'export const broadcast=e=>globalThis.__taskRuntime.events.push(e); export const postActivity=()=>{}',
  './ipc/broadcast': 'export const broadcast=e=>globalThis.__taskRuntime.events.push(e); export const postActivity=()=>{}',
  './ipc/agentRuntime': 'export const loopFn=async name=>name==="sendMessage"?globalThis.__taskRuntime.send:name==="receiveAgentResult"?globalThis.__taskRuntime.receive:async id=>globalThis.__taskRuntime.stopped.push(id)',
  './agent/messageQueueRuntime': 'export const isQueueDraining=()=>false; export const isQueueSuspended=()=>false; export const queueSuspensionGeneration=()=>0'
}
const out = join(root, 'runtime.mjs')
await build({ stdin: { contents: `export * from '../tasks.ts'; export * from './tasks.ts'; export * from './sessions.ts'; export * from './bots.ts'; export { ensureBotHome } from './botHome.ts'; export { flushAll } from './jsonStore.ts'; export { start, abort } from '../agent/cancel.ts'; export { broadcast as event } from '../agent/events.ts';`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{ name: 'app-boundaries', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  }}] })
const api = await import(pathToFileURL(out).href)
await api.loadSessions()
await api.loadTasks()
const bot = api.createBot({ name: 'Fixture', backendId: 'codex', modelId: 'lead-model', followsDefault: false, thinking: 'low' })
const initialExecutionAgent = api.getBot(bot.id).executionAgent
const home = api.ensureBotHome(bot.id)
api.saveSession({ ...home, mode: 'agent', cwd: root })

async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('The local task did not reach its expected boundary')
}
function reply(sessionId, content, extra = {}) {
  const session = api.getSession(sessionId)
  api.saveSession({ ...session, messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', content, createdAt: Date.now(), ...extra }] })
}

test('task panel keeps a busy home free and returns a private result through one durable review', async () => {
  const homeController = api.start(home.id)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  globalThis.__taskRuntime.send = async id => { await barrier; reply(id, 'executor-result') }
  const task = await api.startBackgroundTask(bot.id, 'Do the work', 'private panel task')
  assert.notEqual(task.sessionId, home.id)
  assert.equal(task.sourceSessionId, home.id)
  assert.equal(api.getSession(task.sessionId).archived, true)
  assert.equal(api.getSession(task.sessionId).cwd, root)
  assert.deepEqual(task.executionAgent, { backendId: 'codex', modelId: 'lead-model', thinking: 'low' })
  assert.deepEqual(api.getBot(bot.id).executionAgent, initialExecutionAgent)
  api.updateBot(bot.id, { executionAgent: { backendId: 'codex', modelId: 'new-worker' } })
  release()
  await until(() => api.getTask(task.id).status === 'completed')
  assert.equal(api.getTask(task.id).review, undefined)
  assert.equal(api.getTask(task.id).deliveryStatus, 'pending')
  assert.equal(api.getSession(home.id).messages.some(m => m.content === 'executor-result'), false)
  let received = 0
  globalThis.__taskRuntime.receive = async (id, taskId, _title, result, recorded) => {
    received++
    assert.equal(id, home.id)
    assert.ok(result.startsWith('executor-result\n\nRetained task workspace: ')); assert.ok(result.includes(api.getTask(taskId).workspace.path))
    await api.reviewBackgroundTask(id, bot.id, taskId, 'complete_claimed', 'Reviewed result', ['The private execution returned its result.'])
    await recorded()
    return true
  }
  api.abort(home.id)
  assert.ok(homeController.signal.aborted)
  api.installTaskInbox()
  await until(() => globalThis.__taskRuntime.events.some(event => event.type === 'task-updated' && event.task.id === task.id && event.task.deliveryStatus === 'delivered'))
  api.event({ type: 'done', sessionId: home.id })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(received, 1)
  const saved = JSON.parse(await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8'))
  assert.equal(saved.deliveryStatus, 'delivered')
  assert.equal(saved.review.outcome, 'complete_claimed')
  assert.equal(saved.executionAgent.modelId, 'lead-model')
  assert.ok(globalThis.__taskRuntime.events.some(event => event.type === 'task-updated' && event.task.id === task.id && event.task.deliveryStatus === 'delivered'))
})

test('cancelling a panel task stops its private executor and preserves the primary turn', async () => {
  const primary = api.start(home.id)
  let release
  const barrier = new Promise(resolve => { release = resolve })
  globalThis.__taskRuntime.send = async id => { await barrier; reply(id, 'late partial output') }
  const task = await api.startBackgroundTask(bot.id, 'Cancelable work')
  await until(() => api.getTask(task.id).status === 'running')
  await api.cancelBackgroundTask(task.id)
  assert.deepEqual(globalThis.__taskRuntime.stopped, [task.sessionId])
  assert.equal(primary.signal.aborted, false)
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(api.getTask(task.id).status, 'cancelled')
  assert.equal(api.getTask(task.id).deliveryStatus, 'uncertain')
  api.abort(home.id)
})

test('an acknowledgement alone cannot become a completed executor result', async () => {
  api.start(home.id)
  globalThis.__taskRuntime.send = async id => reply(id, '已收到，正在处理。', { uiOnly: true })
  const task = await api.startBackgroundTask(bot.id, 'No final result')
  await until(() => api.getTask(task.id).status === 'failed')
  assert.match(api.getTask(task.id).result, /before the bot replied/)
  api.updateTaskDelivery(task.id, 'uncertain')
  api.abort(home.id)
})

test('the inbox waits for its lead and never wakes an archived conversation', async () => {
  const teammate = api.createBot({ name: 'Other lead', backendId: 'codex', modelId: 'fixture', followsDefault: false })
  const source = api.getSession(home.id)
  api.saveSession({ ...source, botIds: [bot.id, teammate.id], activeBotId: teammate.id })
  const task = await api.createTaskRecordDurable(bot.id, 'private-fixture', 'Check the original objective', 'ownership', { sourceSessionId: home.id, executionAgent: { backendId: 'codex', modelId: 'fixture' } })
  api.completeAgentTask(task.id, 'owned result')
  let received = 0
  globalThis.__taskRuntime.receive = async (id, taskId, _title, _result, recorded) => {
    received++
    await api.reviewBackgroundTask(id, bot.id, taskId, 'blocked', 'Waiting for the user', [])
    await recorded()
    return true
  }
  api.event({ type: 'done', sessionId: home.id })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(received, 0)
  assert.equal(api.getTask(task.id).deliveryStatus, 'pending')
  api.saveSession({ ...api.getSession(home.id), activeBotId: bot.id })
  api.event({ type: 'done', sessionId: home.id })
  await until(() => api.getTask(task.id).deliveryStatus === 'delivered')
  assert.equal(received, 1)
  const archivedTask = await api.createTaskRecordDurable(bot.id, 'private-archived', 'Work', 'archived source', { sourceSessionId: home.id, executionAgent: task.executionAgent })
  api.completeAgentTask(archivedTask.id, 'returned after archiving')
  api.saveSession({ ...api.getSession(home.id), archived: true })
  api.event({ type: 'done', sessionId: home.id })
  await until(() => api.getTask(archivedTask.id).deliveryStatus === 'uncertain')
  assert.equal(received, 1)
})

test('a retired disable flag cannot block a background task or replace its configured executor', async () => {
  const worker = { backendId: 'kimi', modelId: 'worker-model', thinking: 'high' }
  const legacy = api.createBot({ name: 'Legacy worker', backendId: 'codex', modelId: 'lead-model', followsDefault: false, executionAgent: worker, executionAgentDisabled: true })
  // Also cover a stale in-memory caller, before load/save has removed the flag.
  legacy.executionAgentDisabled = true
  globalThis.__taskRuntime.send = async id => reply(id, 'legacy task result')
  const task = await api.startBackgroundTask(legacy.id, 'Work')
  assert.deepEqual(task.executionAgent, worker)
  await until(() => api.getTask(task.id).status === 'completed')
  api.updateTaskDelivery(task.id, 'uncertain')
  delete legacy.executionAgentDisabled
  const source = api.ensureBotHome(legacy.id)
  const delegated = await api.delegateBackgroundTask(source.id, legacy.id, legacy.id, 'Multi-step work')
  assert.deepEqual(delegated.executionAgent, worker)
  await until(() => api.getTask(delegated.id).status === 'completed')
  api.updateTaskDelivery(delegated.id, 'uncertain')
})

test.after(async () => {
  await api.flushAll()
  if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = previous
  await new Promise(resolve => setTimeout(resolve, 40))
  await rm(root, { recursive: true, force: true })
})
