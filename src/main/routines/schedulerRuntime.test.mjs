import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultSettings } from '../settingsSchema.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-scheduler-runtime-')), old = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
globalThis.__routineRuntime = { sends: 0, send: async () => {}, events: [], activities: [], settingsDefaults: defaultSettings() }
const mocks = {
  '../ipc/broadcast': 'export const broadcast=e=>{globalThis.__routineRuntime.events.push(e);globalThis.__routineRuntime.onEvent?.(e)}; export const postActivity=(...a)=>globalThis.__routineRuntime.activities.push(a)',
  '../ipc/agentRuntime': 'export const loopFn=async name=>name==="sendMessage"?async(...a)=>{globalThis.__routineRuntime.sends++;return globalThis.__routineRuntime.send(...a)}:name==="runRoutine"?globalThis.__routineRuntime.replay??null:null',
  '../agent/messageQueueRuntime': 'export const isQueueDraining=()=>!!globalThis.__routineRuntime.draining',
  '../connectors/githubWatch': 'export const githubIssueFingerprint=async()=>{throw Error("Unexpected network probe")}',
  '../connectors/gmailWatch': 'export const gmailQueryFingerprint=async()=>{throw Error("Unexpected network probe")}',
  '../settings': 'export const getSettings=()=>({...globalThis.__routineRuntime.settingsDefaults,...globalThis.__routineRuntime.settings})'
}
const out = join(root, 'runtime.mjs')
await build({ stdin: { contents: `export * from './scheduler.ts'; export * from './runs.ts'; export * from './notifications.ts'; export * from '../store/routines.ts'; export * from '../store/tasks.ts'; export * from '../store/sessions.ts'; export * from '../store/bots.ts'; export { ensureBotHome } from '../store/botHome.ts'; export { start, abort } from '../agent/cancel.ts'; export { flushAll } from '../store/jsonStore.ts';`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{ name: 'app-boundaries', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  }}] })
const api = await import(pathToFileURL(out).href)
await api.loadSessions()
await api.loadTasks()
const bot = api.createBot({ name: 'Routine fixture', backendId: 'codex', modelId: 'fixture', followsDefault: false })
const home = api.ensureBotHome(bot.id)
api.saveSession({ ...home, cwd: root, mode: 'agent' })
const minute = Math.floor(Date.now() / 60000) * 60000
async function routine(name, since = minute) {
  const r = await api.createRoutineDurable({ botId: bot.id, name, instruction: 'Check the local fixture.', trigger: { kind: 'schedule', cron: '* * * * *' } })
  return api.updateRoutineDurable(r.id, { lastRunAt: since })
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('The scheduler did not reach its expected boundary')
}
function reply(id, extra = {}) {
  const s = api.getSession(id)
  api.saveSession({ ...s, messages: [...s.messages, { id: crypto.randomUUID(), role: 'assistant', content: 'Local observation returned.', createdAt: Date.now(), ...extra }] })
}

test('startup reconciles an interrupted admission to skipped without claiming it ran', async () => {
  const r=await routine('interrupted admission')
  await api.claimRoutineRun(r.id,minute+60000)
  await api.updateRoutineDurable(r.id,{lastRunAt:minute+60000,lastRunState:'claimed'})
  await api.tickRoutineScheduler(minute+60000+1000)
  assert.equal(api.getRoutine(r.id).lastRunState,'skipped')
  const restored=(await api.listRoutineRuns(r.id))[0]
  assert.equal(restored.startedAt,undefined)
  await assert.rejects(api.finishRoutineRun(restored,'finished'),/尚未开始/)
  assert.equal(globalThis.__routineRuntime.sends,0)
  await api.updateRoutineDurable(r.id,{trigger:{kind:'manual'}})
})

test('busy chat defers this minute, misses are recorded without replay and concurrent ticks run once', async () => {
  const r = await routine('busy schedule')
  api.start(home.id)
  await api.tickRoutineScheduler(minute + 3 * 60000 + 20000)
  assert.equal(globalThis.__routineRuntime.sends, 0)
  const missed = (await api.listRoutineRuns(r.id))[0]
  assert.equal(missed.status, 'missed')
  assert.equal(missed.missedCount, 2)
  assert.equal(missed.startedAt, undefined)
  api.abort(home.id)
  globalThis.__routineRuntime.send = async id => reply(id)
  await Promise.all([api.tickRoutineScheduler(minute + 3 * 60000 + 25000), api.tickRoutineScheduler(minute + 3 * 60000 + 25000)])
  await until(() => api.getRoutine(r.id).lastRunState === 'finished')
  await until(() => !api.routineSchedulerBusy())
  assert.equal(globalThis.__routineRuntime.sends, 1)
  assert.equal((await api.listRoutineRuns(r.id)).length, 2)
  await api.tickRoutineScheduler(minute + 3 * 60000 + 40000)
  assert.equal(globalThis.__routineRuntime.sends, 1)
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test('a crash claim overrides a stale legacy watermark and is not replayed', async () => {
  // This imitates a durable claim made after startup by the preceding process.
  // Recovery itself is separately tested against the real on-disk ledger.
  const r = await routine('prior claim')
  await api.claimRoutineRun(r.id, minute + 60000)
  globalThis.__routineRuntime.send = async () => { throw Error('An existing occurrence must not run') }
  const before = globalThis.__routineRuntime.sends
  await api.tickRoutineScheduler(minute + 60000 + 10000)
  await until(() => !api.routineSchedulerBusy())
  assert.equal(globalThis.__routineRuntime.sends, before)
  assert.equal((await api.listRoutineRuns(r.id))[0].status, 'claimed')
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test('a routine acknowledgement alone is unknown and cannot be marked finished', async () => {
  const r = await routine('ack only')
  globalThis.__routineRuntime.send = async id => reply(id, { uiOnly: true })
  await api.tickRoutineScheduler(minute + 60000 + 15000)
  await until(() => api.getRoutine(r.id).lastRunState === 'unknown')
  await until(() => !api.routineSchedulerBusy())
  assert.equal((await api.listRoutineRuns(r.id))[0].status, 'unknown')
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test('a Bot archived during durable admission skips work and clears the running marker', async () => {
  const r = await routine('archived during admission')
  const before = globalThis.__routineRuntime.sends
  globalThis.__routineRuntime.onEvent = event => {
    if (event.type === 'routine-updated' && event.routine.id === r.id && event.routine.lastRunState === 'claimed') api.updateBot(bot.id, { archived: true })
  }
  try {
    await api.tickRoutineScheduler(minute + 60000 + 17000)
    await until(() => api.getRoutine(r.id).lastRunState === 'skipped')
    await until(() => !api.routineSchedulerBusy())
    assert.equal(globalThis.__routineRuntime.sends, before)
    assert.equal((await api.listRoutineRuns(r.id))[0].status, 'skipped')
  } finally {
    globalThis.__routineRuntime.onEvent = undefined
    api.updateBot(bot.id, { archived: false })
    await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
  }
})

test('a delegated routine waits through continuation and finishes only after durable lead review', async () => {
  const r = await routine('delegated')
  let task
  globalThis.__routineRuntime.send = async id => {
    task = await api.createTaskRecordDurable(bot.id, 'private-executor', 'Full routine objective', 'routine task', { sourceSessionId: id, executionAgent: { backendId: 'codex', modelId: 'fixture' } })
    reply(id)
  }
  await api.tickRoutineScheduler(minute + 60000 + 20000)
  await until(async () => (await api.listRoutineRuns(r.id))[0]?.status === 'awaiting_review')
  await until(() => api.getRoutine(r.id).lastRunState === 'awaiting_review')
  assert.equal(api.routineSchedulerBusy(), true)
  api.completeAgentTask(task.id, 'partial')
  api.updateTaskDelivery(task.id, 'delivered')
  const next = await api.createTaskRecordDurable(bot.id, task.sessionId, 'Finish the remaining work', 'continuation', { sourceSessionId: home.id, executionAgent: task.executionAgent, continuedFromTaskId: task.id })
  await api.tickRoutineScheduler(minute + 60000 + 25000)
  assert.equal((await api.listRoutineRuns(r.id))[0].status, 'awaiting_review')
  api.completeAgentTask(next.id, 'final result')
  await api.storeTaskReviewDurable(next.id, { outcome: 'complete_claimed', summary: 'Objective checked', evidence: ['Local fixture result'], recordedAt: Date.now() })
  api.updateTaskDelivery(next.id, 'delivered')
  await api.tickRoutineScheduler(minute + 60000 + 30000)
  const finished = (await api.listRoutineRuns(r.id))[0]
  assert.equal(finished.status, 'finished')
  assert.ok(finished.endedAt)
  assert.deepEqual(finished.taskIds, [task.id])
  assert.equal(api.getRoutine(r.id).lastRunState, 'finished')
  await until(() => !api.routineSchedulerBusy())
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test('manual admission returns false when queued work owns the chat and creates no phantom run', async () => {
  const r = await api.createRoutineDurable({ botId: bot.id, name: 'manual admission', instruction: 'Local check.', trigger: { kind: 'manual' } })
  const before = globalThis.__routineRuntime.sends
  globalThis.__routineRuntime.draining = true
  try {
    assert.equal(await api.runRoutineNow(r.id, home.id), false)
    assert.equal(globalThis.__routineRuntime.sends, before)
    assert.equal(api.getRoutine(r.id).lastRunAt, undefined)
    assert.deepEqual(await api.listRoutineRuns(r.id), [])
  } finally { globalThis.__routineRuntime.draining = false }
})

test('the scheduler discovers a live queue-driven review created after its startup pass', async () => {
  const r=await api.createRoutineDurable({botId:bot.id,name:'live webhook review',trigger:{kind:'webhook'},notifyPolicy:'quiet'})
  const claim=await api.claimWebhookRoutineRun(r.id,'webhook-'+'b'.repeat(64),bot.id,home.id,Date.now())
  const started=await api.startRoutineRun(claim)
  const task=await api.createTaskRecordDurable(bot.id,'webhook-private','Webhook fixture objective','Webhook fixture',{sourceSessionId:home.id,executionAgent:{backendId:'codex',modelId:'fixture'}})
  await api.awaitRoutineReview(started,[task.id])
  await api.tickRoutineScheduler(minute+60000+32000)
  assert.equal(api.routineSchedulerBusy(),true)
  const later=await api.startRoutineRun(await api.claimWebhookRoutineRun(r.id,'webhook-'+'c'.repeat(64),bot.id,home.id,claim.scheduledAt))
  await api.finishRoutineRun(later,'unknown','A newer same-millisecond event needs inspection.')
  await api.updateRoutineDurable(r.id,{lastRunAt:later.scheduledAt,lastRunId:later.id,lastRunState:'unknown',lastRunError:'newer event'})
  api.completeAgentTask(task.id,'Local webhook result')
  await api.storeTaskReviewDurable(task.id,{outcome:'complete_claimed',summary:'Webhook result checked',evidence:['local fixture'],recordedAt:Date.now()})
  api.updateTaskDelivery(task.id,'delivered')
  await api.tickRoutineScheduler(minute+60000+33000)
  const run=(await api.listRoutineRuns(r.id)).find(item=>item.id===started.id)
  assert.equal(run.status,'finished')
  assert.equal(run.result,'Webhook result checked')
  assert.equal(run.notificationState,'quiet')
  assert.equal(api.routineSchedulerBusy(),false)
  assert.equal(api.getRoutine(r.id).lastRunId,later.id)
  assert.equal(api.getRoutine(r.id).lastRunState,'unknown')
  assert.equal(api.getRoutine(r.id).lastRunError,'newer event')
})

test('quiet watcher failures remain visible in state without proactive activity or a claimed run', async () => {
  const r = await api.createRoutineDurable({ botId: bot.id, name: 'quiet watch failure', instruction: 'Local check.', notifyPolicy: 'quiet', trigger: { kind: 'github_issue', owner: 'fixture', repo: 'fixture', issueNumber: 1 } })
  const before = globalThis.__routineRuntime.activities.length
  await api.tickRoutineScheduler(minute + 60000 + 35000)
  await until(() => !api.routineSchedulerBusy())
  assert.equal(api.getRoutine(r.id).watchError, 'Unexpected network probe')
  assert.equal(globalThis.__routineRuntime.activities.length, before)
  assert.equal(api.getRoutine(r.id).lastRunAt, undefined)
  assert.deepEqual(await api.listRoutineRuns(r.id), [])
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test('recorded replay failures and transcripts reach the ledger without replacing its planned time', async () => {
  const r = await api.createRoutineDurable({ botId: bot.id, name: 'recorded failure', trigger: { kind: 'manual' }, notifyPolicy: 'quiet' })
  globalThis.__routineRuntime.replay = async (id, sessionId) => {
    reply(sessionId, { error: 'A recorded local step failed.' })
    api.markRoutineRun(id, Date.now() + 10000)
  }
  try {
    assert.equal(await api.runRoutineNow(r.id, home.id), true)
    const run = (await api.listRoutineRuns(r.id))[0]
    assert.equal(run.status, 'failed')
    assert.equal(run.detail, 'A recorded local step failed.')
    assert.equal(run.result, 'Local observation returned.')
    assert.equal(api.getRoutine(r.id).lastRunAt, run.scheduledAt)
  } finally { globalThis.__routineRuntime.replay = undefined }
})

test('on-change establishes a baseline, suppresses equal results and records one changed notification', async () => {
  const r = await api.createRoutineDurable({ botId:bot.id, name:'changes', notifyPolicy:'on_change' })
  let published=0
  const finish = async (at,text) => api.finishRoutineRun({...(await api.startRoutineRun(await api.claimRoutineRun(r.id,at))),result:text},'finished')
  const first=await api.notifyRoutineResult(await finish(1000,'same result'),r,()=>{published++})
  assert.equal(first.notificationState,'baseline')
  const same=await api.notifyRoutineResult(await finish(2000,'same result'),r,()=>{published++})
  assert.equal(same.notificationState,'unchanged')
  const changed=await finish(3000,'changed result')
  await Promise.all([api.notifyRoutineResult(changed,r,()=>{published++}),api.notifyRoutineResult(changed,r,()=>{published++})])
  assert.equal(published,1)
  assert.equal((await api.listRoutineRuns(r.id))[0].notificationState,'recorded')
  const quiet=await api.notifyRoutineResult(await finish(4000,'quiet result'),{...r,notifyPolicy:'quiet'},()=>{published++})
  assert.equal(quiet.notificationState,'quiet')
  assert.equal(published,1)
})

test('a notification interrupted after durable claim stays uncertain across recovery and is never re-sent', async () => {
  const r=await api.createRoutineDurable({botId:bot.id,name:'notification recovery',notifyPolicy:'always'})
  const run=await api.finishRoutineRun(await api.startRoutineRun(await api.claimRoutineRun(r.id,5000)),'finished')
  await api.saveRoutineRun({...run,notificationState:'pending'})
  const recovered=(await api.recoverRoutineRuns()).find(item=>item.id===run.id)
  assert.equal(recovered.notificationState,'uncertain')
  let sent=0
  await api.notifyRoutineResult(recovered,r,()=>{sent++})
  assert.equal(sent,0)
  const release=api.manageRoutineNotifications('notification-test')
  assert.equal(api.routineOwnsNotifications('notification-test'),true)
  release()
  assert.equal(api.routineOwnsNotifications('notification-test'),false)
})

test('once admits its planned time once and an expired occurrence is missed without execution', async () => {
  const at = minute + 24 * 60 * 60000 + 20000, before = globalThis.__routineRuntime.sends
  globalThis.__routineRuntime.send = async id => reply(id)
  const r = await api.createRoutineDurable({ botId: bot.id, name: 'one occurrence', instruction: 'Observe once', trigger: { kind: 'once', at } })
  await api.tickRoutineScheduler(at - 1)
  assert.equal(globalThis.__routineRuntime.sends, before)
  await Promise.all([api.tickRoutineScheduler(at + 1), api.tickRoutineScheduler(at + 1)])
  await until(() => api.getRoutine(r.id).lastRunState === 'finished')
  await until(() => !api.routineSchedulerBusy())
  const runs = await api.listRoutineRuns(r.id)
  assert.equal(runs.length, 1); assert.equal(runs[0].scheduledAt, at); assert.ok(runs[0].startedAt)
  await api.tickRoutineScheduler(at + 2000)
  assert.equal(globalThis.__routineRuntime.sends, before + 1)
  const past = await api.createRoutineDurable({ botId: bot.id, name: 'expired occurrence', instruction: 'Must not run', trigger: { kind: 'once', at: minute - 3600000 } })
  await api.tickRoutineScheduler(at + 3000)
  const missed = (await api.listRoutineRuns(past.id))[0]
  assert.equal(missed.status, 'missed'); assert.equal(missed.startedAt, undefined)
  assert.equal(globalThis.__routineRuntime.sends, before + 1)
  await api.flushAll()
  const restarted = await import(pathToFileURL(out).href + '?restart-once')
  await restarted.loadSessions(); await restarted.loadTasks(); await restarted.loadBots(); await restarted.loadRoutines()
  await restarted.tickRoutineScheduler(at + 4000)
  await restarted.flushAll()
  assert.equal(globalThis.__routineRuntime.sends, before + 1)
  assert.equal((await restarted.listRoutineRuns(r.id)).length, 1)
})

test('folder baseline is silent, recursive change waits for the busy chat, deny and read failure stay visible', async () => {
  const watched = join(root, 'folder-observation')
  await mkdir(join(watched, 'nested'), { recursive: true })
  const path = await realpath(watched), before = globalThis.__routineRuntime.sends, at = minute + 2 * 24 * 60 * 60000
  const r = await api.createRoutineDurable({ botId: bot.id, name: 'folder observation', instruction: 'Observe metadata changes', trigger: { kind: 'folder_change', path } })
  globalThis.__routineRuntime.send = async id => reply(id)
  await api.tickRoutineScheduler(at)
  await until(() => api.getRoutine(r.id).watchCheckedAt === at)
  const baseline = api.getRoutine(r.id).watchCursor
  assert.ok(baseline); assert.equal(globalThis.__routineRuntime.sends, before)
  api.start(home.id)
  await writeFile(join(watched, 'nested', 'entry'), 'fixture content is never read')
  await api.tickRoutineScheduler(at + 61000)
  await until(() => !api.routineSchedulerBusy())
  assert.equal(api.getRoutine(r.id).watchCursor, baseline)
  api.abort(home.id)
  await api.tickRoutineScheduler(at + 62000)
  await until(() => api.getRoutine(r.id).lastRunState === 'finished')
  await until(() => !api.routineSchedulerBusy())
  assert.equal(globalThis.__routineRuntime.sends, before + 1)
  const current = api.getRoutine(r.id).watchCursor
  globalThis.__routineRuntime.settings = { approvalPolicy: 'auto-run', denylist: [path] }
  await api.tickRoutineScheduler(at + 123000)
  await until(() => !!api.getRoutine(r.id).watchError)
  assert.equal(api.getRoutine(r.id).watchCursor, current)
  globalThis.__routineRuntime.settings = undefined
  await rm(watched, { recursive: true })
  await api.tickRoutineScheduler(at + 184000)
  await until(() => api.getRoutine(r.id).watchCheckedAt === at + 184000)
  assert.ok(api.getRoutine(r.id).watchError); assert.equal(api.getRoutine(r.id).watchCursor, current)
  assert.equal(globalThis.__routineRuntime.sends, before + 1)
  await api.updateRoutineDurable(r.id, { trigger: { kind: 'manual' } })
})

test.after(async () => {
  api.stopRoutineScheduler()
  await api.flushAll()
  if (old === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = old
  await rm(root, { recursive: true, force: true })
})
