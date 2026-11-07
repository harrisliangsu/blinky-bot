/** Durable, per-conversation queue. A started item is never silently replayed. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Attachment } from '../../shared/chat'
import type { MessageQueue, QueuedMessage } from '../../shared/messageQueue'
import { dataRoot } from './paths'
import { readJsonState, writeJsonNow } from './jsonStore'

type Document = { version: 1; queues: Record<string, MessageQueue> }
let document: Document = { version: 1, queues: {} }
let writable = false
let chain: Promise<void> = Promise.resolve()

const file = (): string => join(dataRoot(), 'message-queues.json')
const blank = (sessionId: string): MessageQueue => ({ sessionId, paused: false, items: [] })

/** Writes and memory updates are serialized and a failed write changes neither. */
function change<T>(fn: (next: Document) => T): Promise<T> {
  const operation = chain.then(async () => {
    if (!writable) throw new Error('Message queue storage is unavailable.')
    const next = structuredClone(document)
    const value = fn(next)
    await writeJsonNow(file(), next)
    document = next
    return value
  })
  chain = operation.then(() => undefined, () => undefined)
  return operation
}

export async function loadMessageQueues(): Promise<void> {
  const result = await readJsonState<Document>(file(), { version: 1, queues: {} })
  const queues = result.value?.queues
  const validQueues = queues && typeof queues === 'object' && !Array.isArray(queues) && Object.entries(queues).every(([id, queue]) =>
    queue && queue.sessionId === id && typeof queue.paused === 'boolean' && Array.isArray(queue.items) && queue.items.every((item) =>
      item && typeof item.id === 'string' && typeof item.text === 'string' && Array.isArray(item.attachments) &&
      ['waiting', 'running', 'processing', 'interrupted'].includes(item.status) && typeof item.createdAt === 'number' && (item.targetBotId === undefined || typeof item.targetBotId === 'string')))
  if (result.status === 'unreadable' || result.status === 'corrupt' || !result.value || result.value.version !== 1 || !validQueues) {
    writable = false
    document = { version: 1, queues: {} }
    throw new Error('Message queue data could not be read safely.')
  }
  document = result.value
  writable = true
  if (Object.values(document.queues).some((queue) => queue.items.length)) {
    await change((next) => {
      for (const queue of Object.values(next.queues)) {
        if (!queue.items.length) continue
        queue.paused = true
        for (const item of queue.items) if (item.status === 'running' || item.status === 'processing') item.status = 'interrupted'
      }
    })
  }
}

export function getMessageQueue(sessionId: string): MessageQueue {
  return structuredClone(document.queues[sessionId] ?? blank(sessionId))
}

export function enqueueMessage(sessionId: string, text: string, attachments: Attachment[], paused = false): Promise<MessageQueue> {
  return change((next) => {
    if (!text.trim() && !attachments.length) throw new Error('Message is empty.')
    const queue = next.queues[sessionId] ??= blank(sessionId)
    if (paused) queue.paused = true
    const item: QueuedMessage = { id: randomUUID(), text, attachments, status: 'waiting', createdAt: Date.now() }
    queue.items.push(item)
    return structuredClone(queue)
  })
}

/** Stable LAN receipt ids prevent a retry from adding another turn. */
export function enqueueRoomMessageOnce(sessionId: string, id: string, text: string, paused = false, allowed: () => boolean = () => true, attachments: Attachment[] = []): Promise<MessageQueue> {
  return change((next) => {
    if (!allowed()) throw new Error('Invitation revoked')
    if (!/^room-[a-f0-9]{64}$/.test(id) || !text.trim() || text.length > 20_000) throw new Error('Invalid room message.')
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const existing = queue.items.find(item => item.id === id)
    if (existing) { if (existing.text !== text || JSON.stringify(existing.attachments) !== JSON.stringify(attachments)) throw new Error('Request id conflict'); return structuredClone(queue) }
    if (paused) queue.paused = true
    queue.items.push({ id, text, attachments, status: 'waiting', createdAt: Date.now() })
    return structuredClone(queue)
  })
}

/** Stable channel message ids allow a durably accepted event to be enqueued once. */
export function enqueueExternalMessageOnce(sessionId: string, id: string, text: string, targetBotId: string, paused = false): Promise<MessageQueue> {
  return change((next) => {
    if (!/^(slack|webhook)-[a-f0-9]{64}$/.test(id) || !text.trim() || text.length > 100_000 || !targetBotId || targetBotId.length > 200) throw new Error('Invalid external message.')
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const existing = queue.items.find((item) => item.id === id)
    if (existing) { if (existing.text !== text || existing.targetBotId !== targetBotId) throw new Error('The external message id is already bound to different content.'); return structuredClone(queue) }
    if (paused) queue.paused = true
    queue.items.push({ id, text, attachments: [], status: 'waiting', createdAt: Date.now(), targetBotId })
    return structuredClone(queue)
  })
}

export function setQueuePaused(sessionId: string, paused: boolean): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    if (!paused && queue.items.some((item) => item.status === 'interrupted')) throw new Error('Resolve the interrupted message before resuming.')
    queue.paused = paused
    return structuredClone(queue)
  })
}

/** Stop also covers enqueues already being written when the stop was pressed. */
export function pauseQueueIfNeeded(sessionId: string): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    if (queue.items.length) queue.paused = true
    return structuredClone(queue)
  })
}

export function removeQueuedMessage(sessionId: string, id: string): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const item = queue.items.find((value) => value.id === id)
    if (item?.status === 'running' || item?.status === 'processing') throw new Error('Cannot remove a message while it is running.')
    queue.items = queue.items.filter((value) => value.id !== id)
    return structuredClone(queue)
  })
}

export function startQueuedMessage(sessionId: string, allowRunning = false): Promise<QueuedMessage | null> {
  return change((next) => {
    const queue = next.queues[sessionId]
    if (!queue || queue.paused || queue.items.some((item) => item.status === 'interrupted' || (!allowRunning && (item.status === 'running' || item.status === 'processing')))) return null
    const item = queue.items.find((value) => value.status === 'waiting')
    if (!item) return null
    item.status = 'running'
    return structuredClone(item)
  })
}

/** Keep a recovery receipt after the user message is durable until the run ends. */
export function markQueuedMessageRecorded(sessionId: string, id: string): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const item = queue.items.find((value) => value.id === id)
    if (!item || item.status !== 'running') throw new Error('The message delivery reservation is missing.')
    item.status = 'processing'
    return structuredClone(queue)
  })
}

/** Undo a reservation when Stop arrived before the reserved turn started. */
export function returnQueuedMessage(sessionId: string, id: string): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const item = queue.items.find((value) => value.id === id)
    if (item?.status === 'running') item.status = 'waiting'
    queue.paused = true
    return structuredClone(queue)
  })
}

/** No active turn accepted the message; leave it available for the next attempt. */
export function deferQueuedMessage(sessionId: string, id: string): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const item = queue.items.find((value) => value.id === id)
    if (item?.status === 'running') item.status = 'waiting'
    return structuredClone(queue)
  })
}

export function finishQueuedMessage(sessionId: string, id: string, uncertain: boolean): Promise<MessageQueue> {
  return change((next) => {
    const queue = next.queues[sessionId] ??= blank(sessionId)
    const item = queue.items.find((value) => value.id === id)
    if (item && uncertain) { item.status = 'interrupted'; queue.paused = true }
    else queue.items = queue.items.filter((value) => value.id !== id)
    return structuredClone(queue)
  })
}
