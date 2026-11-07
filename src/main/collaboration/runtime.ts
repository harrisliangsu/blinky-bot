/** Room controls use the same durable queue and stop lifecycle as the Mac UI.
 * Guest text never enters the trusted renderer's mail-send authorization path. */
import { createHash } from 'node:crypto'
import type { Attachment } from '../../shared/types'
import { getSession, getSessionAttachmentData, isSessionMessageDurable } from '../store/sessions'
import { enqueueRoomMessageOnce, getMessageQueue, pauseQueueIfNeeded, setQueuePaused } from '../store/messageQueue'
import { addUserMessage } from '../agent/messages'
import { announceQueue, drainQueue, confirmMessageStored, isQueueSuspended, suspendQueue, unsuspendQueue, queueSuspensionGeneration } from '../agent/messageQueueRuntime'
import { beginQueueWrite, cancelStart, endQueueWrite } from '../agent/startReservation'
import { loopFn } from '../ipc/agentRuntime'
import { listTasks } from '../store/tasks'
import { cancelBackgroundTask } from '../tasks'

export async function enqueueRoomTurn(sessionId: string, token: string, requestId: string, text: string, allowed: () => boolean = () => true, attachments: Attachment[] = []): Promise<{ id: string; duplicate: boolean }> {
  const id = 'room-' + createHash('sha256').update(token + ':' + requestId).digest('hex')
  const session = getSession(sessionId)
  if (!session) throw new Error('Conversation unavailable')
  const recorded = session.messages.find(message => message.id === id)
  const comparable = (files: Attachment[], saved = false) => JSON.stringify(files.map(item => ({ id: item.id, kind: item.kind, name: item.name, path: item.path, mime: item.mime, data: item.data ?? (saved && item.dataRef ? getSessionAttachmentData(sessionId, id, item.id) : undefined) })))
  if (recorded && (recorded.content !== text || comparable(recorded.attachments ?? [], true) !== comparable(attachments))) throw new Error('Request id conflict')
  if (isSessionMessageDurable(sessionId, id)) return { id, duplicate: true }
  // Discover an unavailable execution runtime before accepting a new message.
  if (!await loopFn('sendMessage')) throw new Error('Execution unavailable')
  if (!allowed()) throw new Error('Invitation revoked')
  beginQueueWrite(sessionId)
  try {
    const before = getMessageQueue(sessionId)
    if (!before.items.length && (before.paused || isQueueSuspended(sessionId))) { await setQueuePaused(sessionId, false); unsuspendQueue(sessionId) }
    const duplicate = before.items.some(item => item.id === id)
    const queue = await enqueueRoomMessageOnce(sessionId, id, text, isQueueSuspended(sessionId), allowed, attachments)
    const queued = queue.items.find(item => item.id === id)!
    try {
      await addUserMessage(session, text, attachments, false, queued.id, queued.createdAt)
      await confirmMessageStored(sessionId, id)
    } catch (error) {
      suspendQueue(sessionId); await pauseQueueIfNeeded(sessionId); throw error
    }
    announceQueue(sessionId)
    return { id, duplicate }
  } finally { endQueueWrite(sessionId); void drainQueue(sessionId) }
}

export async function stopRoomTurn(sessionId: string): Promise<void> {
  cancelStart(sessionId); suspendQueue(sessionId)
  await pauseQueueIfNeeded(sessionId); announceQueue(sessionId)
  const stop = await loopFn('stopSession')
  if (!stop) throw new Error('Execution unavailable')
  await stop(sessionId)
  for (const task of listTasks().filter(task => task.sourceSessionId === sessionId && ['queued', 'running'].includes(task.status))) await cancelBackgroundTask(task.id)
}

export async function resumeRoomQueue(sessionId: string): Promise<void> {
  const generation = queueSuspensionGeneration(sessionId)
  await setQueuePaused(sessionId, false)
  if (queueSuspensionGeneration(sessionId) !== generation) throw new Error('Queue changed while resuming')
  unsuspendQueue(sessionId); announceQueue(sessionId); void drainQueue(sessionId)
}
