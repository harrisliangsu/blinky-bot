/** Events first, bounded compensation second; owned by the host. */
import { join } from 'node:path'
import { onAgentEvent } from '../agent/events'
import { addNotice } from '../agent/messages'
import { sessions } from '../agent/sessionGateway'
import { getBot } from '../store/bots'
import { getTask, listTasks } from '../store/tasks'
import { getSession } from '../store/sessions'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow, flushAll } from '../store/jsonStore'
import { TaskProgressMonitor, PROGRESS_SCAN_MS, progressKey, type ProgressState } from './progressMonitor'
import { observeProgressEvent, progressSnapshot } from './progressObservations'
let stop: (() => void) | undefined
export function installTaskProgressMonitor(): void {
  if (stop) return
  let closed = false
  const path = (id: string) => join(dataRoot(), 'task-progress', `${safeFileName(id)}.json`)
  const monitor = new TaskProgressMonitor({
    now: Date.now,
    snapshots: () => closed ? [] : listTasks().filter(t => ['queued', 'running'].includes(t.status) || ['pending', 'uncertain', 'delivering'].includes(t.deliveryStatus ?? '')).flatMap(t => { const s = progressSnapshot(t); return s ? [s] : [] }),
    read: async id => {
      const read = await readJsonState<ProgressState | null>(path(id), null)
      if (read.status === 'missing') return null
      const v = read.value
      if (read.status !== 'ok' || !v || v.version !== 1 || typeof v.owner !== 'string' || typeof v.progress !== 'string' || !Number.isFinite(v.sequence) || !Number.isFinite(v.lastProgressAt) || !Number.isFinite(v.lastNoticeAt) || typeof v.quietReported !== 'boolean' || (v.pending && (typeof v.pending.id !== 'string' || typeof v.pending.snapshot !== 'string' || typeof v.pending.text !== 'string'))) throw new Error('Progress record is unreadable; delivery was not assumed.')
      return v
    },
    write: (id, state) => writeJsonNow(path(id), state),
    post: async (s, notice) => {
      const task = getTask(s.id), fresh = task && progressSnapshot(task)
      if (closed || !task?.sourceSessionId || !fresh || progressKey(fresh) !== notice.snapshot) return false
      const source = await sessions.get(task.sourceSessionId)
      const latest = getTask(s.id), check = latest && progressSnapshot(latest)
      if (closed || !source || !check || progressKey(check) !== notice.snapshot) return false
      if (!source.messages.some(m => m.id === notice.id)) await addNotice(source, getBot(task.requesterBotId ?? task.botId), notice.text, undefined, notice.id)
      const flushed = await flushAll()
      if (flushed.failed.length || flushed.stillWriting || !(await sessions.get(source.id))?.messages.some(m => m.id === notice.id)) throw new Error('Progress notice was not confirmed saved.')
      return true
    },
    error: (id, _error) => {
      console.warn('[openbot/task-progress] observation or delivery unavailable', id)
      // Surface monitoring failure separately from executor failure. The fixed
      // message id deduplicates even if the outbox itself is unreadable.
      const task = getTask(id), snapshot = task && progressSnapshot(task)
      const source = task?.sourceSessionId && getSession(task.sourceSessionId)
      const noticeId = `agent-monitor-unavailable-${id}`
      if (!closed && snapshot && source && !source.messages.some(m => m.id === noticeId)) void addNotice(source, getBot(task!.requesterBotId ?? task!.botId), `${snapshot.title}：暂时无法更新进度。`, undefined, noticeId).catch(() => undefined)
    }
  })
  let debounce: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (debounce) return
    debounce = setTimeout(() => { debounce = undefined; void monitor.scan().catch(() => console.warn('[openbot/task-progress] scan unavailable')) }, 500)
    debounce.unref?.()
  }
  const unsubscribe = onAgentEvent(e => {
    observeProgressEvent(e)
    // Deltas restore transport liveness without producing notices or disk IO.
    if (['task-updated', 'todos', 'approval-request', 'approval-resolved', 'human-help-request', 'human-help-resolved', 'task-clarification-updated', 'backend-notice', 'done'].includes(e.type)) schedule()
  })
  const interval = setInterval(schedule, PROGRESS_SCAN_MS); interval.unref?.()
  stop = () => { closed = true; unsubscribe(); clearInterval(interval); if (debounce) clearTimeout(debounce); stop = undefined }
  schedule()
}
export function stopTaskProgressMonitor(): void { stop?.() }
