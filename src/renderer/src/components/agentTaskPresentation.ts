import type { AgentTask, AgentTaskSummary, AgentTrace, Message, ToolCall, ToolResult } from '../../../shared/types'
import { redactSecrets } from '../../../main/backends/secretRedaction'

export const isEndedTask = (status: string): boolean => ['completed', 'failed', 'cancelled'].includes(status)
export const taskBelongsToBot = (task: Pick<AgentTask, 'botId' | 'requesterBotId'>, botId: string): boolean => task.botId === botId || task.requesterBotId === botId

export function taskStatus(task: Pick<AgentTask, 'status' | 'plan'>, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    queued: ['排队中', 'Queued'], running: ['执行中', 'Running'], completed: ['执行已结束', 'Execution ended'],
    failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], paused: ['已暂停', 'Paused'],
    waiting: ['等待中', 'Waiting'], waiting_for_approval: ['等待确认', 'Awaiting approval']
  }
  const status = labels[task.status]?.[zh ? 0 : 1] ?? (zh ? '状态待确认' : 'Status unconfirmed')
  const priorities = { low: zh ? '稍后' : 'Low', normal: zh ? '普通' : 'Normal', high: zh ? '优先' : 'High', urgent: zh ? '紧急' : 'Urgent' }
  return task.status === 'queued' && task.plan ? status + ' · ' + priorities[task.plan.priority] : status
}

export function taskGroups<T extends AgentTaskSummary>(tasks: T[], botId: string): { active: T[]; ended: T[] } {
  const own = tasks.filter(task => taskBelongsToBot(task, botId)).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return { active: own.filter(task => !isEndedTask(task.status)), ended: own.filter(task => isEndedTask(task.status)) }
}

/** Final saved messages outrank an older live snapshot with the same id. */
export function mergeAgentMessages(saved: Message[], live: Message[]): Message[] {
  const messages = new Map(saved.map(message => [message.id, message]))
  for (const message of live) {
    const previous = messages.get(message.id)
    if (!previous || previous.streaming) messages.set(message.id, message)
  }
  return [...messages.values()].filter(message => !message.internal && !message.uiOnly && message.role !== 'system')
}

const PRIVATE_KEY = /authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|密码|密钥|令牌/i
export function agentText(text: string): string {
  return redactSecrets(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|密码|密钥|令牌)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, '$1[redacted]')
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? agentText(value).slice(0, 32_000) : ''

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return string(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeValue(item, depth + 1))
  return Object.fromEntries(Object.entries(object(value)).slice(0, 30).map(([key, item]) => [key, PRIVATE_KEY.test(key) ? '[redacted]' : safeValue(item, depth + 1)]))
}

export function safeAgentCall(call: ToolCall): ToolCall {
  return { id: call.id, name: string(call.name), args: object(safeValue(call.args)) }
}
export function safeAgentResult(result: ToolResult): ToolResult {
  const detail = object(result.detail)
  // Reuse diff rendering, but never load screenshots or executable/action cards.
  const diff = Object.fromEntries(['diff', 'patch', 'before', 'after', 'path'].filter(key => typeof detail[key] === 'string').map(key => [key, string(detail[key])]))
  return { callId: result.callId, name: string(result.name), ok: result.ok, output: string(result.output), compacted: result.compacted, durationMs: result.durationMs, ...(Object.keys(diff).length ? { detail: diff } : {}) }
}

export interface AgentActivity {
  id: string
  owner: string
  call: ToolCall
  result?: ToolResult
  status: 'running' | 'ok' | 'failed' | 'unknown'
  incomplete: boolean
  output?: string
}

function traceActivity(entry: AgentTrace, raw: Record<string, unknown>, owner: string, running: boolean, incomplete: boolean): AgentActivity {
  const args: Record<string, unknown> = {}
  let name = string(raw.tool) || string(raw.name) || string(raw.title) || 'Tool activity'
  let output = string(raw.aggregatedOutput) || string(raw.output)
  const command = Array.isArray(raw.command) ? raw.command.filter(value => typeof value === 'string').join(' ') : raw.command
  if (entry.kind === 'commandExecution') { name = 'shell'; args.command = string(command); if (raw.cwd) args.cwd = string(raw.cwd) }
  else if (entry.kind === 'fileChange') {
    name = 'edit_file'
    const changes = Array.isArray(raw.changes) ? raw.changes.map(object) : []
    args.path = changes.map(change => string(change.path)).filter(Boolean).join(', ')
    output = changes.map(change => string(change.diff)).filter(Boolean).join('\n')
  } else if (entry.kind === 'webSearch') { name = 'web_search'; args.query = string(raw.query) || string(object(raw.action).query) }
  else {
    Object.assign(args, object(safeValue(raw.arguments ?? raw.rawInput)))
    if (raw.server) args.server = string(raw.server)
    const content = Array.isArray(raw.content) ? raw.content.map(object) : []
    output ||= content.map(item => string(object(item.content).text) || string(item.text)).filter(Boolean).join('\n')
    const result = object(raw.result)
    if (Array.isArray(result.content)) output ||= result.content.map(item => string(object(item).text)).filter(Boolean).join('\n')
  }
  const failed = ['failed', 'declined', 'cancelled'].includes(String(raw.status)) || raw.success === false || raw.error != null || object(raw.result).isError === true || (typeof raw.exitCode === 'number' && raw.exitCode !== 0)
  const ok = !failed && (raw.exitCode === 0 || raw.success === true || (entry.kind !== 'commandExecution' && ['completed', 'succeeded'].includes(String(raw.status))))
  const status = failed ? 'failed' : ok ? 'ok' : entry.phase === 'started' && running ? 'running' : 'unknown'
  const call = safeAgentCall({ id: entry.id, name, args })
  const result = status === 'ok' || status === 'failed'
    ? { callId: entry.id, name: call.name, ok, output: output || (failed ? string(object(raw.error).message) : ''), ...(entry.kind === 'fileChange' && output ? { detail: { diff: output, path: args.path } } : {}) }
    : undefined
  return { id: `native-${entry.kind}-${entry.id}`, owner, call, result, status, incomplete, output }
}

/** Interpret only known display fields; malformed/unknown protocol stays hidden. */
export function agentActivities(messages: Message[], running: boolean): AgentActivity[] {
  const native = new Map<string, { entry: AgentTrace; raw: Record<string, unknown>; owner: string; incomplete: boolean; live: boolean }>()
  const calls = new Map<string, { call: ToolCall; owner: string }>()
  const results = new Map<string, ToolResult>()
  for (const message of messages) {
    if (message.internal || message.uiOnly || message.role === 'system') continue
    for (const call of message.toolCalls ?? []) if (!calls.has(call.id)) calls.set(call.id, { call, owner: message.id })
    if (message.toolResult) results.set(message.toolResult.callId, message.toolResult)
    for (const entry of message.agentTrace ?? []) {
      const key = entry.id, previous = native.get(key)
      let raw: Record<string, unknown> = {}, incomplete = false
      try { raw = object(JSON.parse(entry.detail)) } catch { incomplete = true }
      const kind = previous && /_tool$/.test(entry.kind) ? previous.entry.kind : entry.kind
      native.set(key, { entry: { ...entry, kind }, raw: { ...previous?.raw, ...raw }, owner: previous?.owner ?? message.id, incomplete: incomplete || Boolean(previous?.incomplete), live: Boolean(message.streaming) })
    }
  }
  const activities: AgentActivity[] = [...calls].map(([id, value]) => {
    const result = results.get(id)
    return { id: `app-${id}`, owner: value.owner, call: safeAgentCall(value.call), result: result ? safeAgentResult(result) : undefined, status: result ? result.ok ? 'ok' : 'failed' : running && messages.some(message => message.id === value.owner && message.streaming) ? 'running' : 'unknown', incomplete: Boolean(result?.compacted) }
  })
  for (const message of messages) {
    const result = message.toolResult
    if (!result || calls.has(result.callId) || message.internal || message.uiOnly || message.role === 'system') continue
    activities.push({ id: `result-${result.callId}`, owner: message.id, call: safeAgentCall({ id: result.callId, name: result.name, args: {} }), result: safeAgentResult(result), status: result.ok ? 'ok' : 'failed', incomplete: true })
  }
  for (const value of native.values()) activities.push(traceActivity(value.entry, value.raw, value.owner, running && value.live, value.incomplete))
  return activities
}
