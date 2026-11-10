/**
 * Coercion for persisted sessions.
 *
 * Anything read off disk is treated as untrusted: a half-written file, a
 * document from an older schema, or a message whose stream never finished must
 * all resolve to a valid `Session` rather than crash the app.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type {
  AgentMode,
  Attachment,
  Message,
  Session,
  TodoItem,
  ToolCall,
  ToolResult
} from '../../shared/types'

const MODES: ReadonlyArray<AgentMode> = ['agent', 'ask', 'plan']
const TODO_STATUSES: ReadonlyArray<TodoItem['status']> = ['pending', 'in_progress', 'completed']
const ATTACHMENT_KINDS: ReadonlyArray<Attachment['kind']> = ['file', 'image', 'selection']
/** Keys that address the prototype chain; a persisted object may carry them. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Working directory a brand-new session starts in. Resolved at runtime. */
export function defaultCwd(): string {
  try {
    return homedir() || process.cwd()
  } catch {
    return process.cwd()
  }
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

export function normaliseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const out: TodoItem[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const todo = raw as Record<string, unknown>
    const text = typeof todo['text'] === 'string' ? todo['text'] : ''
    if (!text) continue
    const status = todo['status']
    out.push({
      id: typeof todo['id'] === 'string' && todo['id'] ? todo['id'] : randomUUID(),
      text,
      status: (TODO_STATUSES as ReadonlyArray<string>).includes(status as string)
        ? (status as TodoItem['status'])
        : 'pending'
    })
  }
  return out
}

function normaliseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ToolCall[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const source = raw as Record<string, unknown>
    const id = typeof source['id'] === 'string' ? source['id'] : ''
    const name = typeof source['name'] === 'string' ? source['name'] : ''
    // A call with no id can never be paired with its result, and one with no
    // name is not a call. Either way it is a fragment of an interrupted write.
    if (!id || !name) continue
    const args = source['args']
    out.push({
      id,
      name,
      args: typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {}
    })
  }
  return out.length > 0 ? out : undefined
}

function normaliseToolResult(value: unknown): ToolResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const callId = typeof source['callId'] === 'string' ? source['callId'] : ''
  const name = typeof source['name'] === 'string' ? source['name'] : ''
  if (!callId || !name) return undefined
  const result: ToolResult = {
    callId,
    name,
    ok: source['ok'] === true,
    output: typeof source['output'] === 'string' ? source['output'] : ''
  }
  // `detail` is `unknown` by contract — a renderer hint whose shape belongs to
  // the tool that produced it — so it passes through as written. Its *size* is
  // what the store bounds, in `compaction.ts`.
  if (source['detail'] !== undefined) result.detail = source['detail']
  if (typeof source['screenshot'] === 'string') result.screenshot = source['screenshot']
  if (typeof source['screenshotRef'] === 'string' && /^[a-f0-9]{64}$/.test(source['screenshotRef'])) result.screenshotRef = source['screenshotRef']
  if (typeof source['durationMs'] === 'number') result.durationMs = source['durationMs']
  if (source['compacted'] === true) result.compacted = true
  return result
}

function normaliseAttachments(value: unknown): Attachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Attachment[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const source = raw as Record<string, unknown>
    const kind = source['kind']
    if (!(ATTACHMENT_KINDS as ReadonlyArray<unknown>).includes(kind)) continue
    const attachment: Attachment = {
      id: typeof source['id'] === 'string' && source['id'] ? source['id'] : randomUUID(),
      kind: kind as Attachment['kind'],
      name: typeof source['name'] === 'string' ? source['name'] : ''
    }
    // The bytes ARE the attachment — a `selection` is the user's own highlighted
    // text and no path can reconstruct it — so `data` is carried, not dropped.
    if (typeof source['path'] === 'string') attachment.path = source['path']
    if (typeof source['mime'] === 'string') attachment.mime = source['mime']
    if (typeof source['data'] === 'string') attachment.data = source['data']
    if (typeof source['dataRef'] === 'string' && /^[a-f0-9]{64}$/.test(source['dataRef'])) attachment.dataRef = source['dataRef']
    out.push(attachment)
  }
  return out.length > 0 ? out : undefined
}

function normaliseReactions(value: unknown): Record<string, string[]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string[]> = {}
  for (const [emoji, actors] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(emoji) || emoji.length > 16 || !Array.isArray(actors)) continue
    const people = [
      ...new Set(
        actors
          .filter((actor): actor is string => typeof actor === 'string' && actor.length > 0)
          .map((actor) => actor.slice(0, 80))
      )
    ].slice(0, 100)
    if (people.length > 0) out[emoji] = people
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * One persisted message, rebuilt field by field.
 *
 * This used to spread the parsed object and correct four keys on top, which
 * meant everything else on disk — a `toolResult` of any shape, attachments,
 * whatever a future or forged document happened to carry — travelled straight
 * into the renderer and into the model's context. `compaction.ts` then read
 * `toolResult` structurally on the way back out. Every other normaliser in the
 * store names the fields it accepts; this one now does too, so an unknown key
 * is dropped at the door rather than kept forever.
 */
function normaliseMessage(source: Record<string, unknown>, role: Message['role']): Message {
  const message: Message = {
    id: typeof source['id'] === 'string' && source['id'] ? source['id'] : randomUUID(),
    role,
    content: typeof source['content'] === 'string' ? source['content'] : '',
    createdAt: typeof source['createdAt'] === 'number' ? source['createdAt'] : Date.now()
  }
  if (source['internal'] === true) message.internal = true
  if (source['uiOnly'] === true) message.uiOnly = true
  if (typeof source['displayContent'] === 'string') message.displayContent = source['displayContent']
  // Kept as written, empty string included: the reasoning block is shown for a
  // message that *has* the field, and hiding it would rewrite what was said.
  if (typeof source['reasoning'] === 'string') message.reasoning = source['reasoning']
  if (Array.isArray(source['agentTrace'])) {
    const trace = source['agentTrace'].flatMap((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return []
      const item = raw as Record<string, unknown>
      if (typeof item.id !== 'string' || typeof item.kind !== 'string' || typeof item.detail !== 'string' || (item.phase !== 'started' && item.phase !== 'completed')) return []
      return [{ id: item.id, kind: item.kind, phase: item.phase as 'started' | 'completed', detail: item.detail }]
    })
    if (trace.length) message.agentTrace = trace
  }
  if (Array.isArray(source['segments'])) {
    const segments = source['segments'].flatMap((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return []
      const item = raw as Record<string, unknown>
      if (typeof item.id !== 'string' || typeof item.text !== 'string' || (item.phase !== 'commentary' && item.phase !== 'partial_answer' && item.phase !== 'final_answer')) return []
      return [{ id: item.id, phase: item.phase as NonNullable<Message['segments']>[number]['phase'], text: item.text }]
    })
    if (segments.length > 0 && segments.map((item) => item.text).join('\n\n') === message.content) message.segments = segments
  }

  const toolCalls = normaliseToolCalls(source['toolCalls'])
  if (toolCalls) message.toolCalls = toolCalls
  const toolResult = normaliseToolResult(source['toolResult'])
  if (toolResult) message.toolResult = toolResult
  const attachments = normaliseAttachments(source['attachments'])
  if (attachments) message.attachments = attachments
  const reactions = normaliseReactions(source['reactions'])
  if (reactions) message.reactions = reactions

  for (const key of ['botId', 'handoffTo', 'replyTo', 'model', 'error'] as const) {
    const value = source[key]
    if (typeof value === 'string' && value) message[key] = value
  }
  // A saved streaming assistant is an interrupted executor checkpoint, not a
  // live message after restart. Keep its partial content with an honest label.
  if (source['streaming'] === true && message.role === 'assistant' && !message.error) message.error = '执行中断，以下记录可能不完整。'
  return message
}

function normaliseMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  const out: Message[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const source = raw as Record<string, unknown>
    const role = source['role']
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    out.push(normaliseMessage(source, role))
  }
  return out
}

export function normaliseSession(raw: unknown): Session | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = typeof value['id'] === 'string' ? value['id'] : ''
  if (!id) return null
  const now = Date.now()
  const botIds = stringList(value['botIds'])
  const mode = value['mode']
  const activeBotId = value['activeBotId']

  const session: Session = {
    id,
    title: typeof value['title'] === 'string' && value['title'] ? value['title'] : 'New Chat',
    cwd: typeof value['cwd'] === 'string' && value['cwd'] ? value['cwd'] : defaultCwd(),
    mode: (MODES as ReadonlyArray<string>).includes(mode as string) ? (mode as AgentMode) : 'agent',
    botIds,
    activeBotId:
      typeof activeBotId === 'string' && activeBotId ? activeBotId : (botIds[0] ?? ''),
    messages: normaliseMessages(value['messages']),
    todos: normaliseTodos(value['todos']),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : now,
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : now
  }
  if (value['archived'] === true) session.archived = true
  // Filing survives a reload: a chat put in a project stays in it.
  if (typeof value['projectId'] === 'string' && value['projectId']) {
    session.projectId = value['projectId']
  }
  return session
}
