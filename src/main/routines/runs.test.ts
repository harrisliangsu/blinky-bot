import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitRoutineReview, claimRoutineRun, finishRoutineRun, initializeRoutineRuns, listRoutineRuns, recoverRoutineRuns, routineReviewOutcome, startRoutineRun, type RoutineRun } from './runs.ts'
import type { AgentTask } from '../../shared/types'
import { cronDueWindow } from './cron.ts'

test('one planned minute is claimed once, persists actual times and never replays after recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-runs-')), old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimRoutineRun('routine', 60_000, 65_000)))
    assert.equal(claims.filter(Boolean).length, 1)
    const first = await startRoutineRun(claims.find(Boolean)!, 65_000)
    assert.equal(first.scheduledAt, 60_000)
    assert.equal(first.startedAt, 65_000)
    assert.equal((await listRoutineRuns('routine'))[0].status, 'running')
    await recoverRoutineRuns()
    const unknown = (await listRoutineRuns('routine'))[0]
    assert.equal(unknown.status, 'unknown')
    assert.ok(unknown.endedAt)
    assert.equal(await claimRoutineRun('routine', 60_000), null)
    const next = await startRoutineRun((await claimRoutineRun('routine', 120_000, 121_000))!, 121_000)
    await finishRoutineRun(next!, 'finished', undefined, 125_000)
    const saved = JSON.parse(await readFile(join(root, 'routine-runs', `${next!.id}.json`), 'utf8'))
    assert.equal(saved.startedAt, 121_000)
    assert.equal(saved.endedAt, 125_000)
    assert.equal(saved.status, 'finished')
  } finally {
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial crash claim stays in place and cannot become duplicate permission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-partial-')), old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const run = (await claimRoutineRun('r', 60_000))!
    const file = join(root, 'routine-runs', `${run.id}.json`)
    await writeFile(file, '{partial')
    await assert.rejects(recoverRoutineRuns())
    await assert.rejects(recoverRoutineRuns())
    assert.equal(await readFile(file, 'utf8'), '{partial')
    assert.equal(await claimRoutineRun('r', 60_000), null)
    assert.equal((await readdir(join(root, 'routine-runs'))).length, 1)
  } finally {
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})

test('past planned minutes are missed without a fake start; current minute remains eligible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-missed-')), old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const now = new Date(2026, 10, 6, 9, 3, 20).getTime(), since = new Date(2026, 10, 6, 9, 0, 10).getTime()
    const window = cronDueWindow('* * * * *', since, now)
    assert.equal(window.missed!.count, 2)
    assert.equal(window.scheduledAt, new Date(2026, 10, 6, 9, 3).getTime())
    const missed = await claimRoutineRun('r', window.missed!.lastAt, now, { firstAt: window.missed!.firstAt, count: window.missed!.count })
    assert.equal(missed!.status, 'missed')
    assert.equal(missed!.startedAt, undefined)
    assert.equal(missed!.endedAt, now)
    assert.deepEqual(cronDueWindow('* * * * *', window.scheduledAt!, now), { historyTruncated: false })
    assert.equal(cronDueWindow('0 7 * * *', now, now - 60_000).scheduledAt, undefined)
    assert.equal(cronDueWindow('invalid', since, now).missed, undefined)
    assert.equal(cronDueWindow('0 7 * * *', now - 400 * 86400000, now).historyTruncated, true)
  } finally {
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})

test('pending routine reviews survive recovery without replaying the Bot turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-review-')), old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const run = (await claimRoutineRun('r', 60_000))!
    const pending = await awaitRoutineReview(run, ['task'])
    const restored = (await recoverRoutineRuns())[0]!
    assert.equal(restored.status, 'awaiting_review')
    assert.deepEqual(restored.taskIds, ['task'])
    assert.equal(restored.endedAt, undefined)
    assert.equal(await claimRoutineRun('r', 60_000), null)
    assert.equal(routineReviewOutcome(pending, [] as AgentTask[])?.status, 'unknown')
  } finally {
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})

test('routine completion requires delivered reviews, with uncertain, blocked and inconsistent chains kept unknown', () => {
  const run: RoutineRun = { id: 'fixture', routineId: 'r', scheduledAt: 60_000, status: 'awaiting_review', taskIds: ['root'] }
  const root: AgentTask = { id: 'root', botId: 'bot', sessionId: 'executor', sourceSessionId: 'home', title: 'root', prompt: 'goal', createdAt: 1, updatedAt: 1, status: 'completed', deliveryStatus: 'pending' }
  assert.equal(routineReviewOutcome(run, [root]), null)
  assert.equal(routineReviewOutcome(run, [{ ...root, deliveryStatus: 'uncertain' }])?.status, 'unknown')
  assert.equal(routineReviewOutcome(run, [{ ...root, deliveryStatus: 'delivered', review: { outcome: 'blocked', summary: 'needs user', evidence: [], recordedAt: 2 } }])?.status, 'unknown')
  const reviewed: AgentTask = { ...root, deliveryStatus: 'delivered', review: { outcome: 'complete_claimed', summary: 'checked', evidence: ['readback'], recordedAt: 2 } }
  assert.equal(routineReviewOutcome(run, [reviewed])?.status, 'finished')
  const continuation: AgentTask = { ...root, id: 'next', continuedFromTaskId: root.id, status: 'running' }
  assert.equal(routineReviewOutcome(run, [reviewed, continuation]), null)
  assert.equal(routineReviewOutcome(run, [reviewed, { ...continuation, sourceSessionId: 'another-chat' }])?.status, 'unknown')
  assert.equal(routineReviewOutcome(run, [{ ...root, continuedFromTaskId: 'next' }, continuation])?.status, 'unknown')
})

test('queue and timer share one startup recovery and cannot relabel a new live run as interrupted', async () => {
  const root=await mkdtemp(join(tmpdir(),'blinky-routine-init-')),old=process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR=root
  try {
    const previous=await startRoutineRun((await claimRoutineRun('old',1))!)
    const a=initializeRoutineRuns(),b=initializeRoutineRuns()
    assert.equal(a,b)
    assert.equal((await a).find(run=>run.id===previous.id)?.status,'unknown')
    const live=await startRoutineRun((await claimRoutineRun('live',2))!)
    await initializeRoutineRuns()
    assert.equal((await listRoutineRuns('live'))[0]?.id,live.id)
    assert.equal((await listRoutineRuns('live'))[0]?.status,'running')
  } finally {
    if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old
    await rm(root,{recursive:true,force:true})
  }
})
