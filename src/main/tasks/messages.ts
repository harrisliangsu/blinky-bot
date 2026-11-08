/** Durable per-task delivery receipts. Interrupted deliveries are never replayed. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentTaskMessageReceipt } from '../../shared/activity'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { scrubVaultTranscript } from '../store/vaultPrivacy'

const runtimeId = randomUUID()
export interface TaskMessageReceipt extends AgentTaskMessageReceipt {
  /** Completed assistant messages from the delivered execution turn; not adoption proof. */
  responseMessageIds?: string[]
  /** App message active when native steering was acknowledged, not yet a reply. */
  responseTargetMessageId?: string
}
interface Ledger { runtimeId: string; messages: TaskMessageReceipt[] }

const file = (taskId: string) => join(dataRoot(), 'task-messages', `${safeFileName(taskId)}.json`)

/** Callers serialize a task's decisions, including reads and writes. */
export async function taskMessages(taskId: string): Promise<TaskMessageReceipt[]> {
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

export async function setTaskMessageStatus(taskId: string, requestIds: string[], status: AgentTaskMessageReceipt['status'], delivery?: AgentTaskMessageReceipt['delivery'], responseMessageIds?: string[], responseTargetMessageId?:string): Promise<void> {
  const ids = new Set(requestIds)
  const messages = await taskMessages(taskId)
  await saveTaskMessages(taskId, messages.map(value => ids.has(value.requestId) ? { ...value, status, updatedAt: Date.now(), ...(delivery ? { delivery } : {}), ...(responseTargetMessageId?{responseTargetMessageId}:{}), ...(responseMessageIds?.length && status === 'delivered' ? {responseMessageIds} : {}) } : value))
}

/** Call only for a successfully completed turn, under the task decision lock. */
export async function recordTaskTurnResponses(taskId:string,responseIds:string[]):Promise<void>{
  const ids=new Set(responseIds),messages=await taskMessages(taskId)
  let changed=false
  const next=messages.map(m=>{
    if(m.status!=='delivered'||m.delivery!=='live'||!m.responseTargetMessageId||!ids.has(m.responseTargetMessageId)||m.responseMessageIds?.includes(m.responseTargetMessageId))return m
    changed=true
    return {...m,responseMessageIds:[m.responseTargetMessageId],updatedAt:Date.now()}
  })
  if(changed)await saveTaskMessages(taskId,next)
}
