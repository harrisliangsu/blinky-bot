/** Durable per-task delivery receipts. Interrupted deliveries are never replayed. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentTaskMessageReceipt } from '../../shared/activity'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { scrubVaultTranscript } from '../store/vaultPrivacy'

const runtimeId = randomUUID()
interface Ledger { runtimeId: string; messages: AgentTaskMessageReceipt[] }

const file = (taskId: string) => join(dataRoot(), 'task-messages', `${safeFileName(taskId)}.json`)

/** Callers serialize a task's decisions, including reads and writes. */
export async function taskMessages(taskId: string): Promise<AgentTaskMessageReceipt[]> {
  const read = await readJsonState<Ledger | null>(file(taskId), null)
  if (read.status === 'missing') return []
  if (read.status !== 'ok' || !read.value || typeof read.value.runtimeId !== 'string' || !Array.isArray(read.value.messages)) throw new Error('The task message receipts could not be read safely.')
  const ledger = read.value
  if (ledger.messages.some(value => !value || value.taskId !== taskId || typeof value.requestId !== 'string' || typeof value.text !== 'string' || !['queued', 'delivering', 'delivered', 'uncertain', 'cancelled'].includes(value.status) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt))) throw new Error('The task message receipts are invalid.')
  if (ledger.runtimeId !== runtimeId && ledger.messages.some(value => value.status === 'queued' || value.status === 'delivering')) {
    const messages = ledger.messages.map(value => value.status === 'queued' || value.status === 'delivering' ? { ...value, status: 'uncertain' as const, updatedAt: Date.now() } : value)
    await saveTaskMessages(taskId, messages)
    return messages
  }
  return ledger.messages.map(value => ({ ...value, text: scrubVaultTranscript(value.text) }))
}

export async function saveTaskMessages(taskId: string, messages: AgentTaskMessageReceipt[]): Promise<void> {
  await writeJsonNow(file(taskId), { runtimeId, messages: messages.map(value => ({ ...value, text: scrubVaultTranscript(value.text) })) })
}

export async function setTaskMessageStatus(taskId: string, requestIds: string[], status: AgentTaskMessageReceipt['status'], delivery?: AgentTaskMessageReceipt['delivery']): Promise<void> {
  const ids = new Set(requestIds)
  const messages = await taskMessages(taskId)
  await saveTaskMessages(taskId, messages.map(value => ids.has(value.requestId) ? { ...value, status, updatedAt: Date.now(), ...(delivery ? { delivery } : {}) } : value))
}
