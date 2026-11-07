/** Durable in-app scheduler for recorded routines. */

import type { Routine, Session } from '../../shared/types'
import { isRunning } from '../agent/cancel'
import { hasPendingQueueWrite, isStarting, isStartCancelled, releaseStart, reserveStart } from '../agent/startReservation'
import { isQueueDraining } from '../agent/messageQueueRuntime'
import { onAgentEvent } from '../agent/events'
import { getMessageQueue } from '../store/messageQueue'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { loopFn } from '../ipc/agentRuntime'
import { broadcast, postActivity } from '../ipc/broadcast'
import { ensureBotHome } from '../store/botHome'
import { getBot } from '../store/bots'
import { getRoutine, listRoutines, setRoutineRunState, updateRoutineDurable } from '../store/routines'
import { flushAll } from '../store/jsonStore'
import { cronDueWindow, onceDueWindow } from './cron'
import { awaitRoutineReview, claimRoutineRun, finishRoutineRun, initializeRoutineRuns, listRoutineRuns, routineReviewOutcome, startRoutineRun, type RoutineRun } from './runs'
import { manageRoutineNotifications, notifyRoutineResult } from './notifications'
import { githubIssueFingerprint } from '../connectors/githubWatch'
import { gmailQueryFingerprint } from '../connectors/gmailWatch'
import { listActivity } from '../store/activity'
import { folderMetadataFingerprint } from './folderWatch'
import { getSettings } from '../settings'

const TICK_MS = process.env.BLINKY_SMOKE === '1' && process.env.BLINKY_TEST_WATCH_POLL_MS ? 500 : 30_000
const WATCH_INTERVAL_MS = process.env.BLINKY_SMOKE === '1' && process.env.BLINKY_TEST_WATCH_POLL_MS ? 1000 : 60_000

let timer: ReturnType<typeof setInterval> | undefined
let ticking = false
let recovering: Promise<void> | undefined
const occurrenceWatermarks = new Map<string, number>()
const running = new Set<string>()
const watching = new Set<string>()
const pendingReviews = new Map<string, RoutineRun>()
export function routineSchedulerBusy(): boolean { return ticking || running.size > 0 || watching.size > 0 || pendingReviews.size > 0 }

function targetSession(routine: Routine): Session | null {
  // One chat per bot. A second routine for the same bot waits until that
  // chat is idle; it does not open a side conversation.
  return ensureBotHome(routine.botId)
}

function definition(routine: Routine | null): string {
  return JSON.stringify(routine && [routine.botId, routine.trigger, routine.instruction, routine.steps, routine.replayMode])
}

async function skipOccurrence(run: RoutineRun, detail: string): Promise<void> {
  await finishRoutineRun(run, 'skipped', detail)
  const current = getRoutine(run.routineId)
  if (current?.lastRunAt !== run.scheduledAt || (current.lastRunId && current.lastRunId !== run.id)) return
  const updated = await updateRoutineDurable(run.routineId, { lastRunState: 'skipped', lastRunError: detail })
  if (updated) broadcast({ type: 'routine-updated', routine: updated })
}

async function runScheduled(routine: Routine, now: number, watchCursor?: string, explicitSessionId?: string): Promise<boolean> {
  if (running.has(routine.id) || !getBot(routine.botId) || getBot(routine.botId)?.archived) return false
  running.add(routine.id)
  let invoked = false
  let occurrence: RoutineRun | undefined
  let releaseNotifications = () => {}
  try {
    await initializeRoutineRuns()
    const run = routine.instruction ? null : await loopFn('runRoutine')
    if (!routine.instruction && !run) {
      console.warn(`[openbot/scheduler] agent runtime unavailable for "${routine.name}"`)
      return false
    }

    // Stamp before starting. The 30-second timer can fire again while the replay
    // is waiting for approval; this makes that occurrence exactly-once in-process.
    const session = explicitSessionId ? getSession(explicitSessionId) : targetSession(routine)
    if (!session) throw new Error('The Bot conversation could not be loaded safely; no routine was started.')
    if (session.activeBotId !== routine.botId || session.mode !== 'agent') return false
    if (isRunning(session.id) || isStarting(session.id) || isQueueDraining(session.id) || hasPendingQueueWrite(session.id) || getMessageQueue(session.id).items.length) return false
    const send = routine.instruction ? await loopFn('sendMessage') : null
    if (routine.instruction && !send) throw new Error('The Bot runtime is unavailable.')
    if (isRunning(session.id) || isStarting(session.id) || isQueueDraining(session.id) || hasPendingQueueWrite(session.id) || getMessageQueue(session.id).items.length) return false
    if (definition(getRoutine(routine.id)) !== definition(routine)) return false
    // A scheduled instruction reserves the chat until sendMessage has acquired
    // its controller, so a simultaneous human message cannot steal this slot.
    let reserved = false
    if (routine.instruction) { reserveStart(session.id); reserved = true }
    try {
      const claimed = await claimRoutineRun(routine.id, now)
      occurrenceWatermarks.set(routine.id, Math.max(occurrenceWatermarks.get(routine.id) ?? 0, now))
      if (!claimed) return false
      occurrence = claimed
      let started: Routine | null
      if (watchCursor) {
        const current = getRoutine(routine.id)
        if (!current || definition(current) !== definition(routine) || current.watchCursor !== routine.watchCursor) {
          await skipOccurrence(occurrence, '例程在启动前发生变化，未执行。')
          return false
        }
        started = await updateRoutineDurable(routine.id, { watchCursor, watchCheckedAt: now, watchError: undefined, lastRunAt: now, lastRunId: occurrence.id, lastRunState: 'claimed', lastRunError: undefined })
        if (!started) { await skipOccurrence(occurrence, '例程已删除，未执行。'); return false }
      } else {
        started = await updateRoutineDurable(routine.id, { lastRunAt: now, lastRunId: occurrence.id, lastRunState: 'claimed', lastRunError: undefined })
      }
      const saved = await flushAll()
      if (saved.failed.length || saved.stillWriting) throw new Error('The routine start could not be saved; it was not run.')
      if (started) broadcast({ type: 'routine-updated', routine: started })
      if (reserved && isStartCancelled(session.id)) throw new Error('The routine was stopped before it started.')
      if (!getBot(routine.botId) || getBot(routine.botId)?.archived || definition(getRoutine(routine.id)) !== definition(routine)) {
        await skipOccurrence(occurrence, '例程或 Bot 在启动前发生变化，未执行。')
        return false
      }
      let failure: string | undefined
      let unconfirmed: string | undefined
      let delegatedIds: string[] = []
      let result: string | undefined
      const before = getSession(session.id)?.messages.length ?? 0
      const beforeTasks = new Set(listTasks().map((task) => task.id))
      occurrence = await startRoutineRun(occurrence)
      if ((reserved && isStartCancelled(session.id)) || definition(getRoutine(routine.id)) !== definition(routine) || getSession(session.id)?.activeBotId !== routine.botId) { await skipOccurrence(occurrence, '启动条件已改变，未执行。'); return false }
      releaseNotifications = manageRoutineNotifications(session.id)
      const working = setRoutineRunState(routine.id, 'running')
      if (working) broadcast({ type: 'routine-updated', routine: working })
      const stopListening = onAgentEvent((event) => { if (event.type === 'error' && event.sessionId === session.id) failure = event.message })
      try {
        if (routine.instruction && send) {
          const prefix = !watchCursor ? `[Scheduled routine: ${routine.name}]` : routine.trigger.kind === 'folder_change' ? `[Folder metadata changed: ${routine.trigger.path}]` : routine.trigger.kind === 'gmail_query' ? `[Gmail query results changed: ${routine.trigger.query}]` : `[GitHub issue changed: ${routine.trigger.owner}/${routine.trigger.repo}#${routine.trigger.issueNumber}]`
          invoked = true
          const work = send(session.id, `${prefix}\n\n${routine.instruction}`)
          releaseStart(session.id); reserved = false
          await work
        } else if (run) { invoked = true; await run(routine.id, session.id) }
        const produced = getSession(session.id)?.messages.slice(before) ?? []
        result = produced.filter(message => message.role === 'assistant' && !message.internal && !message.uiOnly).map(message => message.displayContent ?? message.content).join('\n\n').slice(0, 4000)
        failure ??= produced.find((message) => message.error)?.error
        const delegated = listTasks().filter((task) => !beforeTasks.has(task.id) && task.sourceSessionId === session.id)
        delegatedIds = delegated.map((task) => task.id)
        if (!failure && delegatedIds.length) unconfirmed = '例程已派发后台工作，结果仍待主聊天复核；本轮不能确认完成。'
        if (!failure && !unconfirmed && !produced.some((message) => message.role === 'assistant' && !message.internal && !message.uiOnly && message.content.trim())) unconfirmed = '例程调用已结束，但没有可确认的回复；请核对实际工作，未自动重试。'
      } finally { stopListening() }
      const outcome = failure ? 'failed' : unconfirmed ? 'unknown' : 'finished'
      if (!failure && delegatedIds.length) {
        const pending = await awaitRoutineReview(occurrence, delegatedIds)
        pendingReviews.set(pending.id, pending)
      } else await notifyRoutineResult(await finishRoutineRun({ ...occurrence, result }, outcome, failure ?? unconfirmed), getRoutine(routine.id) ?? routine)
      // The recorded replayer also stamps its legacy time on return. Keep the
      // header tied to this durable occurrence's planned time, not finish time.
      const finished = await updateRoutineDurable(routine.id, { lastRunAt: occurrence.scheduledAt, lastRunId: occurrence.id, lastRunState: !failure && delegatedIds.length ? 'awaiting_review' : outcome, lastRunError: failure ?? unconfirmed })
      const persisted = await flushAll()
      if (persisted.failed.length || persisted.stillWriting) throw new Error('The routine result state could not be saved.')
      if (finished) broadcast({ type: 'routine-updated', routine: finished })
    } finally { if (reserved) releaseStart(session.id) }
  } catch (err) {
    console.error(`[openbot/scheduler] routine "${routine.name}" failed`, err)
    const reason = err instanceof Error ? err.message : String(err)
    const detail = invoked ? `The routine started, but its final state could not be confirmed. Inspect its work before retrying. ${reason}` : reason
    if (occurrence) await finishRoutineRun(occurrence, invoked ? 'unknown' : 'failed', detail).then(run => notifyRoutineResult(run, getRoutine(routine.id) ?? routine)).catch((error) => console.error('[openbot/scheduler] could not save occurrence outcome', error))
    const failed = setRoutineRunState(routine.id, invoked ? 'unknown' : 'failed', detail)
    await flushAll().catch(() => undefined)
    if (failed) broadcast({ type: 'routine-updated', routine: failed })
    if (!occurrence && routine.notifyPolicy !== 'quiet' && !listActivity().some((item) => !item.read && item.kind === 'failed' && item.title === routine.name && item.detail === detail && item.botId === routine.botId)) postActivity('failed', routine.name, detail, undefined, routine.botId, true)
  } finally {
    releaseNotifications()
    running.delete(routine.id)
  }
  return invoked
}

async function checkWatch(routine: Routine, now: number): Promise<void> {
  const { owner, repo, issueNumber } = routine.trigger
  if (!routine.instruction || watching.has(routine.id) || !getBot(routine.botId) || getBot(routine.botId)?.archived) return
  watching.add(routine.id)
  try {
    let cursor: string
    if (routine.trigger.kind === 'folder_change' && routine.trigger.path) cursor = await folderMetadataFingerprint(routine.trigger.path, { getSettings })
    else if (routine.trigger.kind === 'gmail_query' && routine.trigger.query !== undefined && routine.trigger.account) cursor = await gmailQueryFingerprint(routine.trigger.query, routine.trigger.account, routine.trigger.accountId)
    else if (routine.trigger.kind === 'github_issue' && owner && repo && issueNumber) cursor = await githubIssueFingerprint(owner, repo, issueNumber)
    else return
    const current = getRoutine(routine.id)
    if (!current || JSON.stringify(current.trigger) !== JSON.stringify(routine.trigger)) return
    if (!current.watchCursor || current.watchCursor === cursor) {
      const updated = await updateRoutineDurable(current.id, { watchCursor: cursor, watchCheckedAt: now, watchError: undefined })
      if (updated) broadcast({ type: 'routine-updated', routine: updated })
      return
    }
    // Save the new cursor together with the running marker only after the chat
    // is reserved. If it is busy, keep the old cursor and check again later.
    await runScheduled(current, now, cursor)
  } catch (error) {
    const current = getRoutine(routine.id)
    if (!current || JSON.stringify(current.trigger) !== JSON.stringify(routine.trigger)) return
    const message = error instanceof Error ? error.message : 'Watch check failed.'
    const updated = await updateRoutineDurable(current.id, { watchCheckedAt: now, watchError: message }).catch(() => null)
    if (updated) broadcast({ type: 'routine-updated', routine: updated })
    if (updated && current.notifyPolicy !== 'quiet' && current.watchError !== message) postActivity('failed', current.name, message, undefined, current.botId, true)
  } finally { watching.delete(routine.id) }
}

export async function tickRoutineScheduler(now = Date.now()): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (!recovering) recovering = initializeRoutineRuns().then(async (runs) => {
      for (const run of runs) {
        occurrenceWatermarks.set(run.routineId, Math.max(occurrenceWatermarks.get(run.routineId) ?? 0, run.scheduledAt))
        if (run.status === 'awaiting_review') pendingReviews.set(run.id, run)
        const routine = getRoutine(run.routineId)
        if (routine?.lastRunAt === run.scheduledAt && (!routine.lastRunId || routine.lastRunId === run.id) && routine.lastRunState !== run.status) {
          const restored = await updateRoutineDurable(routine.id, { lastRunState: run.status, lastRunError: run.detail })
          if (restored) broadcast({ type: 'routine-updated', routine: restored })
        }
        if (routine && run.notificationState === 'ready') await notifyRoutineResult(run, routine)
      }
    }).catch((error) => { recovering = undefined; throw error })
    await recovering
    // Queue-driven events can enter review after this process's startup pass.
    // Discover them without taking ownership of Chat's queue implementation.
    for (const run of await listRoutineRuns()) if (run.status === 'awaiting_review') pendingReviews.set(run.id, run)
    for (const pending of pendingReviews.values()) {
      const outcome = routineReviewOutcome(pending, listTasks())
      if (!outcome) continue
      const finished = await finishRoutineRun({ ...pending, result: outcome.result }, outcome.status, outcome.detail)
      const routine = getRoutine(pending.routineId)
      if (routine) await notifyRoutineResult(finished, routine)
      pendingReviews.delete(pending.id)
      const current = getRoutine(pending.routineId)
      if (current?.lastRunAt === pending.scheduledAt && (!current.lastRunId || current.lastRunId === pending.id)) {
        const updated = await updateRoutineDurable(pending.routineId, { lastRunState: outcome.status, lastRunError: outcome.status === 'unknown' ? outcome.detail : undefined })
        if (updated) broadcast({ type: 'routine-updated', routine: updated })
      }
    }
    const due: Array<{ routine: Routine; scheduledAt: number }> = []
    for (const routine of listRoutines()) {
      if (routine.trigger.kind === 'once' && routine.trigger.at !== undefined && !running.has(routine.id)) {
        const at = routine.trigger.at
        // Exact ledger identity wins over unrelated manual-run watermarks.
        const prior = (await listRoutineRuns(routine.id)).find(run => run.scheduledAt === at)
        if (prior) {
          if (routine.lastRunId !== prior.id || routine.lastRunState !== prior.status) {
            const restored = await updateRoutineDurable(routine.id, { lastRunAt: at, lastRunId: prior.id, lastRunState: prior.status, lastRunError: prior.detail })
            if (restored) broadcast({ type: 'routine-updated', routine: restored })
          }
          continue
        }
        const state = onceDueWindow(at, undefined, now, routine.trigger.lateMinutes)
        if (state === 'due') due.push({ routine, scheduledAt: at })
        else if (state === 'missed') {
          const missed = await claimRoutineRun(routine.id, at, now, { firstAt: at, count: 1 })
          if (definition(getRoutine(routine.id)) !== definition(routine)) continue
          const updated = await updateRoutineDurable(routine.id, { lastRunAt: at, lastRunId: missed?.id,
            lastRunState: 'missed', lastRunError: '已错过一次性计划时间，未自动补跑。' })
          if (updated) broadcast({ type: 'routine-updated', routine: updated })
        }
        continue
      }
      const cron = routine.trigger.kind === 'schedule' ? routine.trigger.cron : undefined
      if (!cron || running.has(routine.id)) continue
      const window = cronDueWindow(cron, Math.max(routine.lastRunAt ?? routine.createdAt, occurrenceWatermarks.get(routine.id) ?? 0), now, routine.trigger)
      if (window.missed) {
        const missed = await claimRoutineRun(routine.id, window.missed.lastAt, now, { firstAt: window.missed.firstAt, count: window.missed.count })
        occurrenceWatermarks.set(routine.id, window.missed.lastAt)
        // Even an existing claim advances the legacy watermark. It may have
        // survived a crash before lastRunAt was saved, and must not run again.
        if (definition(getRoutine(routine.id)) !== definition(routine)) continue
        const updated = await updateRoutineDurable(routine.id, { lastRunAt: window.missed.lastAt, lastRunId: missed?.id, lastRunState: 'missed', lastRunError: `已错过 ${window.missed.count} 次计划，未自动补跑。${window.historyTruncated ? '仅统计最近 366 天，更早记录未补算。' : ''}` })
        if (updated) broadcast({ type: 'routine-updated', routine: updated })
      }
      if (window.scheduledAt !== undefined) due.push({ routine, scheduledAt: window.scheduledAt })
    }
    // Do not hold the scheduler clock open for a replay that can run for hours.
    // Each routine owns its promise and its running guard; later ticks can still
    // start unrelated work on time.
    for (const item of due) void runScheduled(item.routine, item.scheduledAt)
    for (const routine of listRoutines()) {
      if ((routine.trigger.kind === 'github_issue' || routine.trigger.kind === 'gmail_query' || routine.trigger.kind === 'folder_change') && !watching.has(routine.id) && now - (routine.watchCheckedAt ?? 0) >= WATCH_INTERVAL_MS) void checkWatch(routine, now)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[openbot/scheduler] could not reconcile routine occurrences', error)
    if (!listActivity().some((item) => !item.read && item.title === '例程运行记录无法确认' && item.detail === detail)) postActivity('failed', '例程运行记录无法确认', detail)
  } finally {
    ticking = false
  }
}

/** Manual invocation shares the same durable admission and review lifecycle. */
export async function runRoutineNow(routineId: string, sessionId: string): Promise<boolean> {
  const routine = getRoutine(routineId), session = getSession(sessionId)
  if (!routine || !session || session.archived || session.activeBotId !== routine.botId || session.mode !== 'agent') throw new Error('请打开此例程所属 Bot 的执行模式对话。')
  if (running.has(routineId) || isRunning(sessionId) || isStarting(sessionId)) throw new Error('当前已有任务，请稍后运行。')
  return runScheduled(routine, Date.now(), undefined, sessionId)
}

export function startRoutineScheduler(): void {
  if (timer) return
  void tickRoutineScheduler()
  timer = setInterval(() => void tickRoutineScheduler(), TICK_MS)
  timer.unref?.()
}

export function stopRoutineScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
