/** Actual IPC/tool creation + durable local files; no Electron, model or credentials. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultSettings } from '../settingsSchema.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-routine-creation-')), old = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
globalThis.__routineCreation = { handlers: new Map(), settings: defaultSettings(), events: [], accountIds: [] }
const mocks = {
  '../settings': 'export const getSettings=()=>globalThis.__routineCreation.settings',
  '../agent/approval': 'export const requestApproval=async()=>({approved:true,reason:"fixture explicit approval"})',
  '../ipc/broadcast': 'export const broadcast=e=>globalThis.__routineCreation.events.push(e);export const postActivity=()=>{}',
  './broadcast': 'export const broadcast=e=>globalThis.__routineCreation.events.push(e);export const postActivity=()=>{}',
  './handler': 'export const handle=(id,fn)=>globalThis.__routineCreation.handlers.set(id,fn);export const handleEvent=handle;export const handleVoid=handle;export const emptyArray=()=>[];export const nullResult=()=>null',
  '../app/routineLauncher': 'export const getRoutineLauncherStatus=()=>({state:"unavailable"})',
  '../routines/webhookServer': 'export const syncWebhookListener=()=>{};export const webhookStatus=()=>"inactive";export const webhookPort=()=>0',
  '../routines/webhookSecrets': 'export const getOrCreateWebhookSecret=async()=>{throw Error("Unexpected credential access")}',
  '../connectors/googleSecrets': 'export const readGoogleCredentials=async(service,accountId)=>{globalThis.__routineCreation.accountIds.push(accountId);return{account:"fixture@example.invalid"}}',
  '../routines/scheduler': 'export const runRoutineNow=async()=>false',
  './agentRuntime': 'export const AGENT_UNAVAILABLE="unavailable";export const loopFn=async()=>null'
}
await build({ stdin: { contents: `export * from './create.ts';export * from '../store/routines.ts';export * from '../store/bots.ts';export * from '../store/sessions.ts';export {ensureBotHome} from '../store/botHome.ts';export{flushAll}from '../store/jsonStore.ts';export{registerRoutineIpc}from '../ipc/routines.ts';export{scheduleOnceTool}from '../tools/agent/scheduleOnce.ts';export{watchFolderTool}from '../tools/agent/watchFolder.ts';`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, outfile: join(root, 'creation.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'no-external-effects', setup(b) {
  b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
} }] })
const api = await import(pathToFileURL(join(root, 'creation.mjs')).href)
await api.loadSessions()
const bot = api.createBot({ name: 'Creation fixture', backendId: 'codex', modelId: 'fixture', followsDefault: false })
const home = api.ensureBotHome(bot.id)
api.registerRoutineIpc()
const create = globalThis.__routineCreation.handlers.get('openbot:routines:createInstruction')

test('UI IPC creates once with quiet policy in its first durable record; invalid time never creates', async () => {
  const result = await create([bot.id, 'Once from UI', 'Observe fixture', { kind: 'once', at: Date.now() + 120000 }, 'quiet'])
  const saved = JSON.parse(await readFile(join(root, 'routines', result.id + '.json'), 'utf8'))
  assert.equal(saved.trigger.kind, 'once'); assert.equal(saved.notifyPolicy, 'quiet')
  const count = api.listRoutines().length
  await assert.rejects(create([bot.id, 'Invalid', 'Observe', { kind: 'once', at: NaN }, 'quiet']))
  assert.equal(api.listRoutines().length, count)
})

test('folder creation resolves an explicitly allowed alias, establishes metadata baseline, and respects deny rules', async () => {
  const folder = join(root, 'watch'); await mkdir(folder); await symlink(folder, join(root, 'alias'))
  const result = await create([bot.id, 'Folder from UI', 'Observe metadata', { kind: 'folder_change', path: join(root, 'alias') }, 'quiet'])
  assert.equal(result.trigger.path, await realpath(folder)); assert.match(result.watchCursor, /^[a-f0-9]{64}$/)
  const saved = JSON.parse(await readFile(join(root, 'routines', result.id + '.json'), 'utf8'))
  assert.equal(saved.notifyPolicy, 'quiet'); assert.equal(saved.watchCursor, result.watchCursor)
  globalThis.__routineCreation.settings = { ...defaultSettings(), denylist: [await realpath(folder)] }
  await assert.rejects(create([bot.id, 'Denied folder', 'Observe metadata', { kind: 'folder_change', path: folder }]), /限制拒绝/)
  globalThis.__routineCreation.settings = defaultSettings()
})

test('new tools use actual durable creator hooks and Gmail account selection reaches stored trigger', async () => {
  const ctx = { sessionId: home.id, botId: bot.id, cwd: root, signal: new AbortController().signal, settings: defaultSettings(), emit: () => {}, requestApproval: async () => true,
    host: { scheduleOnceRoutine: api.createOnceInstruction, watchFolderRoutine: api.createFolderWatch } }
  const one = await api.scheduleOnceTool.handler({ name: 'Once from tool', instruction: 'Observe fixture', at: Date.now() + 180000 }, ctx)
  assert.equal(one.ok, true)
  const watched = await api.watchFolderTool.handler({ name: 'Folder from tool', instruction: 'Observe fixture', path: join(root, 'watch') }, ctx)
  assert.equal(watched.ok, true)
  const gmail = await api.createGmailWatch(home.id, bot.id, 'Selected Gmail', 'Check fixture', 'is:unread', 'selected-account')
  assert.equal(gmail.trigger.accountId, 'selected-account')
  assert.equal(globalThis.__routineCreation.accountIds.at(-1), 'selected-account')
})

test.after(async () => {
  await api.flushAll()
  if (old === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = old
  await rm(root, { recursive: true, force: true })
})
