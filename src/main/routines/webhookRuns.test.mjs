/** Only Node, temporary SQLite/JSON, and mocked Chat boundaries. No Electron. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'blinky-webhook-runs-')), old = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
const state = globalThis.__webhookRuns = { bot: { id: 'bot' }, session: { id: 'home', activeBotId: 'bot', botIds: ['bot'], mode: 'agent', messages: [] }, tasks: [], events: [], activities: [] }
const mocks = {
  '../store/bots': `export const getBot=id=>id==='bot'?globalThis.__webhookRuns.bot:null`,
  '../store/sessions': `export const getSession=id=>id==='home'?globalThis.__webhookRuns.session:null`,
  '../store/tasks': `export const listTasks=()=>globalThis.__webhookRuns.tasks`,
  '../ipc/broadcast': `export const broadcast=e=>{globalThis.__webhookRuns.events.push(e);globalThis.__webhookRuns.onEvent?.(e)};export const postActivity=(...a)=>globalThis.__webhookRuns.activities.push(a)`
}
const outfile = join(root, 'test.mjs')
await build({ stdin: { contents: `export * from './src/main/routines/webhookRuns.ts';export * from './src/main/routines/webhookInbox.ts';export * from './src/main/routines/runs.ts';export * from './src/main/routines/notifications.ts';export * from './src/main/store/routines.ts';export {flushAll} from './src/main/store/jsonStore.ts'`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'no-desktop-or-provider', setup(b) {
    b.onResolve({ filter: /^electron(?:\/|$)/ }, () => { throw Error('Electron must never be loaded by these tests') })
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  }}] })
const api = await import(pathToFileURL(outfile).href)
await api.loadRoutines()
async function fixture(name, policy = 'quiet') {
  const routine = await api.createRoutineDurable({ botId: 'bot', name, instruction: 'Controlled local fixture.', trigger: { kind: 'webhook' }, notifyPolicy: policy })
  const event = await api.acceptWebhookSignal(routine.id, 'bot', 'event-1', name, routine.instruction)
  await api.markWebhookQueued(event.id)
  const handle = await api.prepareWebhookRoutineRun('home', event.id, 'bot')
  return { routine, event, handle }
}
function recorded(event) { state.session.messages.push({ id: event.id, role: 'user', content: 'Controlled local fixture.', createdAt: event.createdAt }) }
const signal = () => new AbortController().signal

test('acceptance/queueing/preparation create no run; identity comes from authenticated inbox', async () => {
  const { routine, event, handle } = await fixture('queued only')
  assert.deepEqual(await api.listRoutineRuns(routine.id), [])
  assert.equal((await api.getWebhookSignal(event.id)).instruction, '')
  assert.equal(await api.prepareWebhookRoutineRun('home', 'normal-user-message'), null)
  await assert.rejects(api.prepareWebhookRoutineRun('home', event.id, 'other-bot'), /identity/)
  await assert.rejects(api.prepareWebhookRoutineRun('home', 'webhook-'+'a'.repeat(64), 'bot'), /identity/)
  handle.release()
})

test('only actual-start callback admits work; duplicate starts/settles cannot execute or rewrite twice', async () => {
  const { routine, event, handle } = await fixture('one real boundary')
  recorded(event)
  assert.equal(await handle.start(signal()), true)
  assert.equal(await handle.start(signal()), false)
  const running = (await api.listRoutineRuns(routine.id))[0]
  assert.equal(running.status, 'running'); assert.ok(running.startedAt)
  const [a,b] = await Promise.all([handle.settle({ status: 'returned', result: 'A local result.' }), handle.settle({ status: 'failed', error: 'late duplicate' })])
  assert.equal(a.status, 'finished'); assert.equal(b.id, a.id)
  assert.equal(a.notificationState, 'quiet')
  const duplicate = await api.prepareWebhookRoutineRun('home', event.id, 'bot')
  assert.equal(await duplicate.start(signal()), false)
  assert.equal(await duplicate.settle({ status: 'failed', error: 'must not overwrite' }), null)
  assert.equal((await api.listRoutineRuns(routine.id))[0].result, 'A local result.')
})

test('different event IDs at one millisecond remain separate, and on-change observes both results', async () => {
  const routine = await api.createRoutineDurable({ botId: 'bot', name: 'same time', instruction: 'Local.', trigger: { kind: 'webhook' }, notifyPolicy: 'on_change' })
  const now = Date.now; let first, second
  try { Date.now=()=>1700000000000; first=await api.acceptWebhookSignal(routine.id,'bot','one','same time','Local.');second=await api.acceptWebhookSignal(routine.id,'bot','two','same time','Local.') }
  finally { Date.now=now }
  assert.equal(first.createdAt, second.createdAt); assert.notEqual(first.id, second.id)
  const before = state.activities.length
  for (const [event,result] of [[first,'old result'],[second,'new result']]) {
    recorded(event)
    const h=await api.prepareWebhookRoutineRun('home',event.id,'bot')
    assert.equal(await h.start(signal()),true)
    await h.settle({status:'returned',result})
  }
  const runs=await api.listRoutineRuns(routine.id)
  assert.equal(runs.length,2);assert.notEqual(runs[0].id,runs[1].id)
  assert.equal(api.getRoutine(routine.id).lastRunId,runs.find(r=>r.webhook.signalId===second.id).id)
  assert.equal(state.activities.length,before+1)
  assert.deepEqual(new Set(runs.map(r=>r.notificationState)),new Set(['baseline','recorded']))
  const replay=await api.acceptWebhookSignal(routine.id,'bot','one','same time','Local.')
  assert.equal(replay.id,first.id)
})

test('cancellation before start never records startedAt; cancellation after start stays unknown', async () => {
  const before=await fixture('cancel before','on_change')
  const skipped=await before.handle.settle({status:'cancelled'})
  assert.equal(skipped.status,'skipped');assert.equal(skipped.startedAt,undefined)
  assert.equal(await before.handle.start(signal()),false)
  const fresh=await api.acceptWebhookSignal(before.routine.id,'bot','event-2','cancel before','Local.')
  recorded(fresh)
  const next=await api.prepareWebhookRoutineRun('home',fresh.id,'bot')
  assert.equal(await next.start(signal()),true)
  assert.equal((await next.settle({status:'returned',result:'First actual result.'})).notificationState,'baseline')
  const after=await fixture('cancel after');recorded(after.event)
  assert.equal(await after.handle.start(signal()),true)
  const unknown=await after.handle.settle({status:'cancelled',result:'Partial local work.'})
  assert.equal(unknown.status,'unknown');assert.ok(unknown.startedAt)
  const aborted=await fixture('already aborted');recorded(aborted.event)
  const controller=new AbortController();controller.abort()
  assert.equal(await aborted.handle.start(controller.signal),false)
  const final=await aborted.handle.settle({status:'not_started'})
  assert.equal(final.status,'skipped');assert.equal(final.startedAt,undefined)
})

test('Bot changes while preparing or during start persistence cannot authorize another Bot', async () => {
  const f=await fixture('owner switch');recorded(f.event)
  state.session.activeBotId='other'
  assert.equal(await f.handle.start(signal()),false)
  assert.equal((await f.handle.settle({status:'not_started'})).startedAt,undefined)
  state.session.activeBotId='bot'
  const race=await fixture('owner switch after persistence');recorded(race.event)
  state.onEvent=e=>{if(e.type==='routine-updated'&&e.routine.id===race.routine.id&&e.routine.lastRunState==='running')state.session.activeBotId='other'}
  try {
    assert.equal(await race.handle.start(signal()),false)
    const final=await race.handle.settle({status:'not_started'})
    assert.equal(final.status,'skipped');assert.equal(final.startedAt,undefined)
  } finally {state.onEvent=undefined;state.session.activeBotId='bot'}
})

test('empty/failed outcomes are truthful and only owned delegated tasks enter review', async () => {
  for (const [outcome,expected] of [[{status:'returned'},'unknown'],[{status:'failed',error:'Fixture error'},'failed']]) {
    const f=await fixture('explicit outcome');recorded(f.event);await f.handle.start(signal())
    assert.equal((await f.handle.settle(outcome)).status,expected)
  }
  const delegated=await fixture('review');recorded(delegated.event);await delegated.handle.start(signal())
  state.tasks=[{id:'owned',sourceSessionId:'home',botId:'executor-bot',requesterBotId:'bot',sessionId:'private',status:'running'}]
  const pending=await delegated.handle.settle({status:'returned',taskIds:['owned']})
  assert.equal(pending.status,'awaiting_review')
  assert.equal(api.routineReviewOutcome(pending,state.tasks),null)
  assert.equal(api.routineReviewOutcome(pending,[{...state.tasks[0],sourceSessionId:'elsewhere'}]).status,'unknown')
  const other=await fixture('foreign task');recorded(other.event);await other.handle.start(signal())
  assert.equal((await other.handle.settle({status:'returned',taskIds:['foreign']})).status,'unknown')
})

test('concurrent cancellation waits for the start gate; corrupt claims remain fail-closed', async () => {
  const f=await fixture('concurrent cancel');recorded(f.event)
  const controller=new AbortController()
  const start=f.handle.start(controller.signal);controller.abort()
  const settle=f.handle.settle({status:'cancelled'})
  assert.equal(await start,false)
  assert.equal((await settle).startedAt,undefined)
  const broken=await fixture('corrupt claim')
  const claim=await api.claimWebhookRoutineRun(broken.routine.id,broken.event.id,'bot','home',broken.event.createdAt)
  const file=join(root,'routine-runs',claim.id+'.json'), original=await readFile(file,'utf8')
  await writeFile(file,'{partial')
  try {
    recorded(broken.event)
    assert.equal(await broken.handle.start(signal()),false)
    assert.equal(await broken.handle.settle({status:'uncertain'}),null)
    await assert.rejects(api.getRoutineRun(claim.id))
    assert.equal(await readFile(file,'utf8'),'{partial')
  } finally {await writeFile(file,original)}
})

test('fresh Node process recovers started event as unknown and cannot re-admit its stable ID', async () => {
  const f=await fixture('restart boundary');recorded(f.event);await f.handle.start(signal());f.handle.release()
  const run=(await api.listRoutineRuns(f.routine.id))[0]
  const module=pathToFileURL(resolve('src/main/routines/runs.ts')).href
  const script=`import * as r from ${JSON.stringify(module)}; const runs=await r.recoverRoutineRuns();const run=runs.find(x=>x.id===${JSON.stringify(run.id)});const duplicate=await r.claimWebhookRoutineRun(run.routineId,run.webhook.signalId,run.webhook.botId,run.webhook.sessionId,run.scheduledAt);console.log(JSON.stringify({status:run.status,duplicate,startedAt:run.startedAt}))`
  const child=spawnSync(process.execPath,['--experimental-transform-types','--import',resolve('scripts/register-ts.mjs'),'--input-type=module','-e',script],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
  const result=JSON.parse(child.stdout.trim())
  assert.equal(result.status,'unknown');assert.equal(result.duplicate,null);assert.ok(result.startedAt)
})

test.after(async () => {
  await api.flushAll()
  if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old
  delete globalThis.__webhookRuns
  await rm(root,{recursive:true,force:true})
})
