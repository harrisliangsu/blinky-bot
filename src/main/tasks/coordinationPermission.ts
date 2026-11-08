/** Automatic task messages mutate execution: use the ordinary approval policy. */
import { join } from 'node:path'
import { requestApproval } from '../agent/approval'
import { getSettings } from '../settings'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { progressPermissionRevision } from './progressTurn'

interface CommunicationPermission {
  version: 1; owner: string; permissions: string; requestId: string
  state: 'checking' | 'approved' | 'denied' | 'deferred'; updatedAt: number
}
const file = (id: string) => join(dataRoot(), 'task-communication-permissions', `${safeFileName(id)}.json`)
export async function communicationPermissionStatus(id: string): Promise<CommunicationPermission | null | { state: 'unavailable' }> {
  const read = await readJsonState<CommunicationPermission | null>(file(id), null)
  if (read.status === 'missing') return null
  const value = read.value
  return read.status === 'ok' && value?.version === 1 && typeof value.owner === 'string' && typeof value.permissions === 'string' &&
    ['checking', 'approved', 'denied', 'deferred'].includes(value.state) ? value : { state: 'unavailable' }
}
export async function authorizeCoordination(input: {
  taskId: string; owner: string; sessionId: string; botId: string; requestId: string
  text: string; kind: 'ask' | 'advise'; signal: AbortSignal; valid(): Promise<boolean>
}): Promise<'approved' | 'not-permitted' | 'deferred'> {
  if (input.signal.aborted || !await input.valid()) return 'deferred'
  const permissions = progressPermissionRevision(getSettings())
  const old = await communicationPermissionStatus(input.taskId)
  // A refusal, timeout or interrupted permission card is not authority to ask
  // again under a new message id. Only an explicit permission-setting change
  // makes a fresh automatic approval attempt eligible.
  if (old && (old.state === 'unavailable' || old.owner !== input.owner ||
    old.permissions === permissions && ['checking', 'denied'].includes(old.state))) return 'not-permitted'
  const state: CommunicationPermission = { version: 1, owner: input.owner, permissions, requestId: input.requestId, state: 'checking', updatedAt: Date.now() }
  await writeJsonNow(file(input.taskId), state)
  const call = { id: input.requestId, name: 'manage_task', args: { action: 'message', task_id: input.taskId, request_id: input.requestId, text: input.text } }
  const outcome = await requestApproval({ sessionId: input.sessionId, botId: input.botId, toolName: 'manage_task', call,
    target: `message:${input.taskId}`, kind: 'write', localExecution: false, signal: input.signal,
    summary: input.kind === 'ask' ? '向执行会话询问进展' : '向执行会话发送建议',
    detail: `任务：${input.taskId}\n\n${input.text}` })
  state.state = outcome.approved ? 'approved' : input.signal.aborted ? 'deferred' : 'denied'
  state.updatedAt = Date.now()
  await writeJsonNow(file(input.taskId), state)
  if (!outcome.approved) return state.state === 'deferred' ? 'deferred' : 'not-permitted'
  return !input.signal.aborted && await input.valid() ? 'approved' : 'deferred'
}
