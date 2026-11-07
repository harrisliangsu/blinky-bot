/** Routine-side lifecycle contract. Chat must call start at its actual executor boundary. */
import type { RoutineRun } from '../../shared/routines'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { getRoutine, updateRoutineDurable } from '../store/routines'
import { listTasks } from '../store/tasks'
import { broadcast } from '../ipc/broadcast'
import { getWebhookSignal } from './webhookInbox'
import { awaitRoutineReview, claimWebhookRoutineRun, finishRoutineRun, initializeRoutineRuns, startRoutineRun } from './runs'
import { manageRoutineNotifications, notifyRoutineResult } from './notifications'

export interface WebhookRunOutcome {
  status: 'returned' | 'failed' | 'cancelled' | 'not_started' | 'uncertain'
  result?: string
  error?: string
  taskIds?: string[]
}

export interface WebhookRunHandle {
  readonly botId: string
  readonly signalId: string
  /** Await immediately before the first backend call. False means do not execute. */
  start(signal: AbortSignal): Promise<boolean>
  /** Use the explicit execution outcome, never merely onRecorded or fulfilled Promise<void>. */
  settle(outcome: WebhookRunOutcome): Promise<RoutineRun | null>
  /** Always release in Chat's finally, including callback/persistence failure. */
  release(): void
}

export async function prepareWebhookRoutineRun(sessionId: string, messageId: string, targetBotId?: string): Promise<WebhookRunHandle | null> {
  if (!messageId.startsWith('webhook-')) return null
  const savedEvent = await getWebhookSignal(messageId)
  if (!savedEvent || !targetBotId || targetBotId !== savedEvent.botId) throw new Error('Webhook event identity or original Bot does not match the queue item.')
  const event = savedEvent
  await initializeRoutineRuns()
  const validSource = () => {
    const routine = getRoutine(event.routineId), bot = getBot(event.botId), session = getSession(sessionId)
    return Boolean(routine?.trigger.kind === 'webhook' && routine.botId === event.botId && bot && !bot.archived && session && !session.archived && session.mode === 'agent' && session.activeBotId === event.botId && session.botIds.length === 1 && session.botIds[0] === event.botId)
  }
  const release = manageRoutineNotifications(sessionId)
  let occurrence: RoutineRun | undefined
  let startAttempted = false
  let starting: Promise<boolean> | undefined
  let settlement: Promise<RoutineRun | null> | undefined
  const claim = () => claimWebhookRoutineRun(event.routineId, event.id, event.botId, sessionId, event.createdAt)
  async function publish(run: RoutineRun): Promise<RoutineRun> {
    const routine = getRoutine(event.routineId)
    if (!routine || routine.botId !== event.botId) return run
    // Older concurrent events must not replace the latest occurrence header.
    if ((routine.lastRunAt ?? -Infinity) < run.scheduledAt || (routine.lastRunAt === run.scheduledAt && (!routine.lastRunId || routine.lastRunId === run.id))) {
      const saved = await updateRoutineDurable(routine.id, { lastRunAt: run.scheduledAt, lastRunId: run.id, lastRunState: run.status, lastRunError: run.detail })
      if (saved) broadcast({ type: 'routine-updated', routine: saved })
    }
    return notifyRoutineResult(run, routine)
  }
  async function settle(outcome: WebhookRunOutcome): Promise<RoutineRun | null> {
    try {
      if (!occurrence) {
        // A duplicate start belongs to the preceding process/handle. Never
        // rewrite its running, terminal or damaged record from this callback.
        if (startAttempted) return null
        occurrence = await claim() ?? undefined
        if (!occurrence) return null
      }
      if (occurrence.endedAt !== undefined) return occurrence
      if (occurrence.startedAt === undefined || outcome.status === 'not_started') {
        return publish(await finishRoutineRun(occurrence, 'skipped', outcome.error || '队列任务未获执行器开始确认，未执行。'))
      }
      if (outcome.status === 'returned' && outcome.taskIds?.length) {
        const tasks = new Map(listTasks().map(task => [task.id, task]))
        const owned = outcome.taskIds.every(id => { const task = tasks.get(id); return task?.sourceSessionId === sessionId && (task.requesterBotId ?? task.botId) === event.botId })
        if (owned) return publish(await awaitRoutineReview(occurrence, outcome.taskIds))
        return publish(await finishRoutineRun(occurrence, 'unknown', '后台任务不属于原 Bot／对话，未确认完成。'))
      }
      const status = outcome.status === 'returned' && outcome.result?.trim() ? 'finished' : outcome.status === 'failed' ? 'failed' : 'unknown'
      const detail = outcome.error || (status === 'unknown' ? '执行已中断或结果未确认；请核对实际工作，未自动重试。' : undefined)
      return publish(await finishRoutineRun({ ...occurrence, result: outcome.result?.slice(0, 4000) }, status, detail))
    } finally { release() }
  }
  return {
    botId: event.botId,
    signalId: event.id,
    start(signal) {
      if (startAttempted || settlement) return Promise.resolve(false)
      starting = start(signal)
      return starting
    },
    settle(outcome) {
      settlement ??= (async () => { try { await starting; return await settle(outcome) } finally { release() } })()
      return settlement
    },
    release
  }

  async function start(signal: AbortSignal): Promise<boolean> {
      startAttempted = true
      const claimed = await claim()
      if (!claimed) return false
      occurrence = claimed
      // Transcript durability is established by Chat before this callback.
      const recorded = getSession(sessionId)?.messages.some(message => message.id === event.id && message.role === 'user')
      if (!recorded || !validSource() || signal.aborted) {
        occurrence = await publish(await finishRoutineRun(occurrence, 'skipped', '原 Bot／对话、输入或启动条件已改变，未执行。'))
        return false
      }
      occurrence = await startRoutineRun(occurrence)
      if (!validSource() || signal.aborted) {
        occurrence = await publish(await finishRoutineRun(occurrence, 'skipped', '启动条件在记录期间改变，未执行。'))
        return false
      }
      const routine = getRoutine(event.routineId)
      if (routine && (routine.lastRunAt ?? -Infinity) <= occurrence.scheduledAt) {
        const saved = await updateRoutineDurable(routine.id, { lastRunAt: occurrence.scheduledAt, lastRunId: occurrence.id, lastRunState: 'running', lastRunError: undefined })
        if (saved) broadcast({ type: 'routine-updated', routine: saved })
      }
      // Chat rechecks the signal/owner synchronously immediately before invoking
      // its backend; any failure after this write is conservatively unknown.
      if (signal.aborted || !validSource()) {
        occurrence = await publish(await finishRoutineRun(occurrence, 'skipped', '实际调用前启动条件已改变，未执行。'))
        return false
      }
      return true
  }
}
