/** Exercise the actual broadcast + routine ledger with Electron fully replaced. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'blinky-notification-contract-'))
const previous = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
const state = globalThis.__routineNotifications = { sent: [], native: [], notifications: [], focused: null, activeTasks: new Set(), settings: { notifications: true, notifyOnTurn: true } }
const mocks = {
  electron: `const s=globalThis.__routineNotifications; export class BrowserWindow { constructor(){throw Error('Real or fake window creation is forbidden')} static getAllWindows(){return [{isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(...args)=>s.sent.push(args)}}]} static getFocusedWindow(){return s.focused} } export class Notification { static isSupported(){return true} constructor(value){this.value=value;this.id=value.id??String(Math.random());this.handlers={}} on(name,fn){this.handlers[name]=fn} close(){} show(){s.notifications.push(this.value);this.handlers.show?.()} }`,
  '../settings': `export const getSettings=()=>globalThis.__routineNotifications.settings;export const onSettingsChanged=()=>()=>{}`,
  '../store/bots': `export const getBot=id=>({id,name:'Fixture Bot'})`,
  '../store/sessions': `export const getSession=id=>({id,title:'Fixture chat',activeBotId:'bot',messages:globalThis.__routineNotifications.messages??[]})`,
  '../store/tasks': `export const hasActiveTask=id=>globalThis.__routineNotifications.activeTasks.has(id);export const listTasks=()=>[]`,
  '../app/window': `export const focusOrCreateWindow=()=>{throw Error('Window focus is forbidden')}`,
  '../native/stdioBridge': `export const sendNativeEvent=e=>globalThis.__routineNotifications.native.push(e)`
}
for (const [a,b] of [['./settings','../settings'],['./store/sessions','../store/sessions'],['./app/window','../app/window']]) mocks[a]=mocks[b]
const outfile = join(root, 'test.mjs')
await build({ stdin: { contents: `export * from './src/main/ipc/broadcast.ts';export * from './src/main/routines/notifications.ts';export * from './src/main/routines/runs.ts';export * from './src/main/store/activity.ts';export {flushAll} from './src/main/store/jsonStore.ts'`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'forbid-electron-runtime', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  }}] })
const api = await import(pathToFileURL(outfile).href)
await api.loadActivity()
function count() { return api.listActivity().length }
let seq=0;const running=new Set()
const start=id=>{if(!running.has(id)){running.add(id);api.broadcast({type:'run-started',sessionId:id})}}
const done = sessionId => {start(sessionId);const id='reply-'+(++seq);state.messages=[{id,role:'assistant',content:'Fixture reply',createdAt:1}];api.broadcast({type:'message-end',sessionId,messageId:id});api.broadcast({type:'done',sessionId,outcome:'completed'});running.delete(sessionId)}
const error = sessionId => {start(sessionId);api.broadcast({type:'error',sessionId,message:'Fixture failure'})}


test('normal background chat posts one completion; error + done posts only failure', () => {
  let before = count(), notifications = state.notifications.length
  done('normal')
  assert.equal(count(), before + 1)
  assert.equal(state.notifications.length, notifications + 1)
  before = count()
  error('normal-error'); done('normal-error')
  assert.equal(count(), before + 1)
  assert.equal(api.listActivity().find(a => a.sessionId === 'normal-error').kind, 'failed')
})

test('routine error/done stays live but quiet; subsequent normal chat is unaffected', () => {
  const release = api.manageRoutineNotifications('routine')
  const before = count(), notices = state.notifications.length, native = state.native.length, sent = state.sent.length
  error('routine'); done('routine')
  assert.equal(count(), before)
  assert.equal(state.notifications.length, notices)
  assert.deepEqual(state.native.slice(native).map(e => e.type), ['run-started', 'error', 'message-end', 'done'])
  assert.deepEqual(state.sent.slice(sent).map(([, e]) => e.type), ['run-started', 'error', 'message-end', 'done'])
  release()
  done('routine')
  assert.equal(count(), before + 1)
  assert.equal(api.listActivity().find(a => a.sessionId === 'routine').kind, 'completed')
})

test('leases are nested, scoped and idempotent; failed state cannot escape a managed turn', () => {
  const a = api.manageRoutineNotifications('nested'), b = api.manageRoutineNotifications('nested')
  a(); a()
  assert.equal(api.routineOwnsNotifications('nested'), true)
  let before = count()
  done('other-chat')
  assert.equal(count(), before + 1)
  error('nested')
  b(); b()
  assert.equal(api.routineOwnsNotifications('nested'), false)
  before = count(); done('nested')
  assert.equal(count(), before) // A failed turn never becomes a success when its lease ends.
  done('nested'); assert.equal(count(), before + 1)
  // A failure from a preceding turn also cannot taint the next ordinary turn.
  error('stale-error')
  const c = api.manageRoutineNotifications('stale-error')
  done('stale-error'); c()
  before = count(); done('stale-error')
  assert.equal(count(), before + 1)
})

test('routine approvals/help and generic events retain their normal behavior', () => {
  const release = api.manageRoutineNotifications('approval-chat')
  const before = count(), notices = state.notifications.length
  api.broadcast({ type: 'approval-request', request: { id: 'approval', sessionId: 'approval-chat', summary: 'Approve fixture' } })
  api.broadcast({ type: 'human-help-request', request: { id: 'help', sessionId: 'approval-chat', botId: 'bot', reason: 'Fixture help', createdAt: 1 } })
  const sent = state.sent.length, native = state.native.length
  for (const event of [{ type: 'run-started', sessionId: 'approval-chat' }, { type: 'text-delta', sessionId: 'approval-chat', messageId: 'm', delta: 'text' }, { type: 'task-updated', task: { id: 'task' } }, { type: 'activity-updated', item: { id: 'activity' } }]) api.broadcast(event)
  assert.equal(count(), before + 2)
  assert.equal(state.notifications.length, notices + 2)
  assert.equal(state.sent.length, sent + 4)
  assert.equal(state.native.length, native + 4)
  release()
})

test('active tasks, focus and global desktop settings remain respected', () => {
  state.activeTasks.add('executor')
  let before = count()
  error('executor'); done('executor')
  assert.equal(count(), before)
  state.focused = {}
  done('focused'); error('focused-error')
  assert.equal(count(), before + 2)
  state.focused = null
  state.settings.notifications = false
  let notices = state.notifications.length
  done('desktop-disabled')
  assert.equal(state.notifications.length, notices)
  state.settings.notifications = true
  state.settings.notifyOnTurn = false
  done('turn-desktop-disabled')
  assert.equal(state.notifications.length, notices)
  state.settings.notifyOnTurn = true
})

test('quiet/on-change/always use the real ledger and emit no duplicate generic notification', async () => {
  const routine = { id: 'fixture-routine', name: 'Fixture routine', botId: 'bot', notifyPolicy: 'quiet' }
  let before = count(), notices = state.notifications.length
  const complete = async (at, result, policy) => {
    const release = api.manageRoutineNotifications('routine-chat')
    const started = await api.startRoutineRun(await api.claimRoutineRun(routine.id, at))
    done('routine-chat'); release()
    return api.notifyRoutineResult(await api.finishRoutineRun({ ...started, result }, 'finished'), { ...routine, notifyPolicy: policy })
  }
  assert.equal((await complete(1000, 'quiet result', 'quiet')).notificationState, 'quiet')
  assert.equal(count(), before)
  assert.equal(state.notifications.length, notices)
  // Separate routine: its first result establishes its own baseline.
  routine.id = 'changes'
  assert.equal((await complete(2000, 'same result', 'on_change')).notificationState, 'baseline')
  assert.equal((await complete(3000, 'same result', 'on_change')).notificationState, 'unchanged')
  assert.equal(count(), before)
  const changed = await complete(4000, 'changed result', 'on_change')
  assert.equal(changed.notificationState, 'recorded')
  assert.equal(count(), before + 1)
  await api.notifyRoutineResult(changed, routine)
  assert.equal(count(), before + 1)
  await complete(5000, 'changed result', 'always')
  assert.equal(count(), before + 2)
})

test.after(async () => {
  await api.flushAll()
  if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = previous
  delete globalThis.__routineNotifications
  await rm(root, { recursive: true, force: true })
})
