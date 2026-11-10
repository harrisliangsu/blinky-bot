import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'blinky-memory-runtime-'))
const previous = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
globalThis.__memoryRuntime = { sideCall: async () => ({ text: '[]' }), events: [], failures: [] }
const mocks = {
  '../ipc/broadcast': 'export const broadcast=e=>globalThis.__memoryRuntime.events.push(e); export const postActivity=(...a)=>globalThis.__memoryRuntime.failures.push(a)',
  './backendGateway': 'export const getBackendInfo=async()=>null; export const runSideCall=(...a)=>globalThis.__memoryRuntime.sideCall(...a)'
}
const out = join(root, 'runtime.mjs')
await build({ stdin: { contents: `export * from './memory.ts'; export * from './memoryQueue.ts'; export { memoryStore } from './memoryGateway.ts'; export * from '../store/memory.ts'; export * from '../store/sessions.ts'; export * from '../store/bots.ts'; export { flushAll } from '../store/jsonStore.ts'; export { getSettings } from '../settings.ts';`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{ name: 'app-boundaries', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  }}] })
const api = await import(pathToFileURL(out).href)
await api.loadMemory()
await api.loadSessions()
const bot = api.createBot({ name: 'Memory fixture', backendId: 'codex', modelId: 'memory-model', followsDefault: false })
function exchange(text) {
  const session = api.createSession([bot.id])
  return api.saveSession({ ...session, cwd: root, messages: [{ id: crypto.randomUUID(), role: 'user', content: text, createdAt: Date.now() }, { id: crypto.randomUUID(), role: 'assistant', content: 'Received.', createdAt: Date.now() }] })
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Memory work did not reach the expected boundary')
}
const jobs = () => readdir(join(root, 'memory-extraction')).catch(() => [])

test('simultaneous remember calls produce one durable memory and one acknowledgement', async () => {
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => api.rememberFact(bot.id, '用户偏好先核对真实执行结果，再提供简短的中文结论。', 'user')))
  assert.equal(outcomes.filter(o => o.entry).length, 1)
  assert.equal(outcomes.filter(o => o.reason === 'already remembered').length, 5)
  assert.equal(api.listBotMemory(bot.id).length, 1)
  assert.equal(globalThis.__memoryRuntime.events.filter(e => e.type === 'memory-updated').length, 1)
})

test('stop during the asynchronous memory read cannot write after cancellation', async () => {
  const session = exchange('用户偏好使用本地隔离目录验证更改。')
  const original = api.memoryStore.list
  let release, entered = false
  const barrier = new Promise(resolve => { release = resolve })
  api.memoryStore.list = async id => { entered = true; await barrier; return original(id) }
  globalThis.__memoryRuntime.sideCall = async () => ({ text: '["用户偏好使用本地隔离目录验证更改。"]' })
  try {
    await api.enqueueMemoryExtraction(session, bot, api.getSettings(), 'supervised')
    await until(() => entered)
    api.stopExtraction(session.id)
    release()
    await until(async () => (await jobs()).length === 0)
    assert.equal(api.listBotMemory(bot.id).some(e => e.text.includes('隔离目录')), false)
    assert.equal(globalThis.__memoryRuntime.failures.length, 0)
  } finally { release(); api.memoryStore.list = original }
})

test('an explicit deletion while the model is running is not undone by its stale result', async () => {
  const entry = await api.rememberFact(bot.id, '用户偏好将历史记录按主题单独保留。', 'user')
  const session = exchange('Discuss the established workflow.')
  let release, entered = false
  const barrier = new Promise(resolve => { release = resolve })
  globalThis.__memoryRuntime.sideCall = async () => { entered = true; await barrier; return { text: '["用户偏好将历史记录按主题单独保留。"]' } }
  await api.enqueueMemoryExtraction(session, bot, api.getSettings(), 'supervised')
  await until(() => entered)
  assert.equal(api.removeBotMemory(bot.id, entry.entry.id), true)
  await api.flushAll()
  release()
  await until(async () => (await jobs()).length === 0)
  assert.equal(api.listBotMemory(bot.id).some(e => e.text.includes('历史记录')), false)
})

test('recovery never reruns a write-phase job with an unknown partial result', async () => {
  const session = exchange('Do not replay an interrupted extraction.')
  const job = await api.createMemoryJob({ sessionId: session.id, botId: bot.id, boundaryId: session.messages.at(-1).id, mode: 'supervised', memoryFingerprint: 'a'.repeat(64) })
  await api.saveMemoryJob({ ...job, state: 'writing' })
  let calls = 0
  globalThis.__memoryRuntime.sideCall = async () => { calls++; return { text: '[]' } }
  await api.recoverMemoryExtractions()
  await until(async () => (await jobs()).length === 0)
  assert.equal(calls, 0)
  assert.equal(globalThis.__memoryRuntime.failures.length, 1)
})

test('a permitted extraction stores its screened fact before removing the recovery record', async () => {
  const session = exchange('用户习惯在项目中保留简短的验证记录。')
  globalThis.__memoryRuntime.sideCall = async () => ({ text: '["用户习惯在项目中保留简短的验证记录。"]' })
  await api.enqueueMemoryExtraction(session, bot, api.getSettings(), 'supervised')
  await until(async () => (await jobs()).length === 0)
  const document = JSON.parse(await readFile(join(root, 'memory', `${bot.id}.json`), 'utf8'))
  assert.ok(document.entries.some(e => e.source === 'run' && e.text.includes('简短的验证记录')))
  assert.equal(api.listBotMemory(bot.id).filter(e => e.text.includes('简短的验证记录')).length, 1)
})

test('post-forget extraction receives only the latest user input, excluding old facts and assistant restatements', async () => {
  const old = '用户习惯使用深绿色信封整理纸质项目资料。'
  const entry = await api.writeUserMemory(bot.id, old)
  await api.removeBotMemoryDurable(bot.id, entry.id)
  const session = api.createSession([bot.id])
  const at = Math.max(Date.now(), api.automaticMemoryCutoff(bot.id) + 1)
  api.saveSession({ ...session, cwd: root, messages: [
    { id: crypto.randomUUID(), role: 'user', content: old, createdAt: at - 5000 },
    { id: crypto.randomUUID(), role: 'assistant', content: old, createdAt: at - 4000 },
    { id: crypto.randomUUID(), role: 'user', content: '用户喜欢在周末阅读天文学的入门书籍。', createdAt: at },
    { id: crypto.randomUUID(), role: 'assistant', content: old, createdAt: at + 1 }
  ] })
  let calls = 0
  globalThis.__memoryRuntime.sideCall = async (_backend, request) => {
    calls++
    const input = request.messages.at(-1).content
    assert.equal(input.includes('深绿色信封'), false)
    assert.equal(input.includes('天文学'), true)
    return { text: '[]' }
  }
  await api.enqueueMemoryExtraction(api.getSession(session.id), bot, api.getSettings(), 'supervised')
  await until(async () => (await jobs()).length === 0)
  assert.equal(calls, 1)
  assert.equal(api.listBotMemory(bot.id).some(e => e.text === old), false)
})

test.after(async () => {
  api.stopAllExtraction()
  await api.flushAll()
  if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = previous
  delete globalThis.__memoryRuntime
  await rm(root, { recursive: true, force: true })
})
