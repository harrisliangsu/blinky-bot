/**
 * Agent CLIs take one prompt per turn and keep their own history, so a
 * conversation is flattened into a transcript: prior turns as context, the
 * newest user turn as the actual request.
 */

import { imagePartsOf, textOf } from '../messageContent'
import type { ProviderMessage } from '../types'

const LABELS: Record<string, string> = {
  system: 'System instructions',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool result'
}

function imageNote(count: number): string {
  return count
    ? `\n[${count} image attachment${count === 1 ? '' : 's'} omitted — this CLI takes text only]`
    : ''
}

function renderTurn(m: ProviderMessage): string {
  const label = LABELS[m.role] ?? m.role
  const images = imageNote(imagePartsOf(m.content).length)
  const body = textOf(m.content).trim()
  if (m.role === 'tool') return `${label} (${m.name ?? 'tool'}):\n${body}${images}`
  const calls = (m.toolCalls ?? [])
    .map((c) => `\n[called ${c.name} ${JSON.stringify(c.args ?? {})}]`)
    .join('')
  return `${label}:\n${body}${calls}${images}`
}

export interface FlattenOptions {
  /**
   * Whether the system turn stays inside the transcript. Defaults to `true`.
   *
   * A CLI with a system-prompt flag receives the prompt through it, so leaving
   * the system turn in the transcript as well sends the whole thing twice in
   * one request — measurably the largest source of prompt crowding on these
   * backends, and enough to push a local model past the point where it still
   * follows its instructions. Those adapters pass `false`.
   *
   * Codex and OpenCode have no such flag: for them the transcript is the only
   * carrier the instructions have, which is why the default keeps it. Dropping
   * it there would silently strip the system prompt.
   */
  includeSystem?: boolean
  /**
   * Keep assistant/tool turns that follow the newest user message.
   *
   * Ordinary agent CLIs own their tool loop, so the newest user turn is their
   * request. Pi's VM-safe model-only mode instead uses OpenBOT's loop: after a
   * tool runs, its result is necessarily after that user turn and must remain
   * in the next prompt or the model will repeat the same call forever.
   */
  includeTrailingTurns?: boolean
}

export function flattenTranscript(messages: ProviderMessage[], opts: FlattenOptions = {}): string {
  const keepSystem = opts.includeSystem !== false
  const usable = messages.filter(
    (m) => (keepSystem || m.role !== 'system') && (textOf(m.content).trim() || m.toolCalls?.length)
  )
  if (!usable.length) return ''
  if (opts.includeTrailingTurns === true) return usable.map(renderTurn).join('\n\n')

  const lastUser = usable.map((m) => m.role).lastIndexOf('user')
  if (lastUser === -1) return usable.map(renderTurn).join('\n\n')

  const context = usable.slice(0, lastUser)
  const request = textOf(usable[lastUser].content).trim()
  if (!context.length) return request

  return ['<conversation-so-far>', ...context.map(renderTurn), '</conversation-so-far>', '', request].join('\n')
}

/**
 * The newest user turn on its own.
 *
 * A session transport keeps the conversation itself, so re-sending the whole
 * transcript every turn would duplicate history the CLI already has. Only the
 * first turn of a session needs {@link flattenTranscript}; later turns send
 * this. Falls back to the flattened form when there is no user turn to isolate.
 */
export function latestUserTurn(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const text = textOf(messages[i].content).trim()
    if (text) return text
  }
  return flattenTranscript(messages)
}

/**
 * Prompt for one Codex app-server turn.
 *
 * The first turn of a thread carries the transcript. Later turns send only the
 * new user text: the thread already has the history, and resending it makes
 * the model re-read the whole chat before the first token.
 */
export function codexTurnPrompt(primed: boolean, messages: ProviderMessage[]): string {
  if (!primed) return flattenTranscript(messages)
  const latest = latestUserTurn(messages).trim()
  return latest || flattenTranscript(messages)
}

/** System turns are passed separately by CLIs that support it. */
export function systemPromptOf(messages: ProviderMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join('\n\n')
}
