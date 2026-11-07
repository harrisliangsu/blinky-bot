/** The routine ledger, rather than a generic Chat done event, owns notification intent. */
import { createHash } from 'node:crypto'
import type { Routine, RoutineRun } from '../../shared/routines'
import { postActivity } from '../ipc/broadcast'
import { flushAll } from '../store/jsonStore'
import { claimRoutineNotification, listRoutineRuns, saveRoutineRun } from './runs'
import { listTasks } from '../store/tasks'
import { manageRoutineNotifications } from './notificationOwnership'
export { manageRoutineNotifications, routineOwnsNotifications } from './notificationOwnership'

const notifying = new Set<string>()

export async function manageRoutineTaskResult(taskId: string, sessionId: string): Promise<() => void> {
  const ancestors = new Set([taskId]), tasks = new Map(listTasks().map(task => [task.id, task]))
  let task = tasks.get(taskId)
  while (task?.continuedFromTaskId && !ancestors.has(task.continuedFromTaskId)) { ancestors.add(task.continuedFromTaskId); task = tasks.get(task.continuedFromTaskId) }
  let runs: RoutineRun[]
  try { runs = await listRoutineRuns() }
  catch { console.warn('[openbot/routines] notification ownership could not be read; unrelated task delivery was retained'); return () => undefined }
  const owned = runs.some(run => run.taskIds?.some(id => ancestors.has(id)))
  return owned ? manageRoutineNotifications(sessionId) : () => undefined
}

export async function notifyRoutineResult(run: RoutineRun, routine: Routine, publish = (text: string) => postActivity(run.status === 'failed' || run.status === 'unknown' ? 'failed' : 'info', routine.name, text, undefined, routine.botId, true)): Promise<RoutineRun> {
  if (run.notificationState !== 'ready' || notifying.has(run.id)) return run
  notifying.add(run.id)
  try {
    const saved = (await listRoutineRuns(routine.id)).find(item => item.id === run.id)
    if (!saved || saved.notificationState !== 'ready') return saved ?? run
    run = saved
    const text = (run.result || run.detail || (run.status === 'finished' ? '例程本轮已结束。' : `例程状态：${run.status}`)).slice(0, 4000)
    const fingerprint = createHash('sha256').update(`${run.status}:${text.normalize('NFKC').replace(/\s+/g, ' ').trim()}`).digest('hex')
    const previous = (await listRoutineRuns(routine.id)).filter(item => item.id !== run.id && item.startedAt !== undefined && item.resultFingerprint)
      .sort((a,b) => (b.resultObservedAt ?? b.endedAt ?? b.scheduledAt) - (a.resultObservedAt ?? a.endedAt ?? a.scheduledAt))[0]
    const state = routine.notifyPolicy === 'quiet' || run.status === 'skipped' ? 'quiet'
      : routine.notifyPolicy === 'on_change' && !previous && run.status === 'finished' ? 'baseline'
      : routine.notifyPolicy === 'on_change' && previous?.resultFingerprint === fingerprint ? 'unchanged' : undefined
    const next = { ...run, resultFingerprint: fingerprint, resultObservedAt: Math.max(Date.now(), previous?.resultObservedAt ?? 0) + 1 }
    if (state) return await saveRoutineRun({ ...next, notificationState: state })
    if (!await claimRoutineNotification(run)) {
      const latest = (await listRoutineRuns(routine.id)).find(item => item.id === run.id) ?? run
      return latest.notificationState === 'ready' ? saveRoutineRun({ ...latest, notificationState: 'uncertain' }) : latest
    }
    // Persist intent before any notification side effect. A crash after this
    // boundary becomes uncertain; never automatically send it a second time.
    await saveRoutineRun({ ...next, notificationState: 'pending' })
    try {
      await publish(text)
      const flush = await flushAll()
      if (flush.failed.length || flush.stillWriting) throw new Error('通知记录无法确认。')
      return await saveRoutineRun({ ...next, notificationState: 'recorded' })
    } catch { return await saveRoutineRun({ ...next, notificationState: 'uncertain' }) }
  } finally { notifying.delete(run.id) }
}
