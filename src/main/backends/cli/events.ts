/**
 * Translators from a CLI's stdout JSON into `ChatChunk`s.
 *
 * These CLIs run their own tool loop, so tool activity is surfaced as reasoning
 * (visible to the user, not re-executed by us). Mappers are created per run
 * because some CLIs stream deltas *and* repeat the finished message.
 */

import { isPlainObject } from '../lenientJson'
import type { ChatChunk } from '../types'

export type EventMapper = (value: unknown) => ChatChunk[]

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Pull readable text out of an Anthropic-shaped record, for error reporting. */
function errorTextOf(value: Record<string, unknown>): string {
  const message = isPlainObject(value.message) ? value.message : value
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isPlainObject)
    .map((block) => str(block.text))
    .filter(Boolean)
    .join(' ')
}

export function toolLine(name: string, input: unknown): string {
  const summary = isPlainObject(input)
    ? Object.entries(input)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${(JSON.stringify(v) ?? '').slice(0, 60)}`)
        .join(', ')
    : ''
  return `⏺ ${name}${summary ? `(${summary})` : ''}\n`
}

/**
 * Claude Code's `stream-json`, which Droid also emits: Anthropic-shaped
 * assistant messages with text / thinking / tool_use blocks.
 */
export function anthropicStyleMapper(): EventMapper {
  return (value) => {
    if (!isPlainObject(value)) return []
    const type = str(value.type)

    if (type === 'error') {
      throw new Error(str(value.message) || str(value.error) || 'agent CLI reported an error')
    }

    /*
     * Failures arrive dressed as an ordinary assistant turn — the text reads
     * "Failed to authenticate: ..." and only `is_api_error_message` (or the
     * final `is_error` result record) marks it as a failure. Without this the
     * error would render as if the model had said it, and the turn would look
     * successful. Expired CLI auth is the common case.
     */
    if (value.is_error === true || value.is_api_error_message === true) {
      throw new Error(str(value.result) || errorTextOf(value) || 'agent CLI reported an error')
    }

    if (type !== 'assistant' && type !== 'message') return []

    const message = isPlainObject(value.message) ? value.message : value
    const content = message.content
    if (typeof content === 'string') return content ? [{ type: 'text', delta: content }] : []
    if (!Array.isArray(content)) return []

    const out: ChatChunk[] = []
    for (const block of content) {
      if (!isPlainObject(block)) continue
      const kind = str(block.type)
      if (kind === 'text' && str(block.text)) out.push({ type: 'text', delta: str(block.text) })
      else if (kind === 'thinking' && str(block.thinking)) {
        out.push({ type: 'reasoning', delta: str(block.thinking) })
      } else if (kind === 'tool_use') {
        out.push({ type: 'reasoning', delta: toolLine(str(block.name), block.input) })
      }
    }
    return out
  }
}

/** Readable message out of a codex error record, which nests under `error`. */
function codexError(record: Record<string, unknown>): string {
  const direct = str(record.message) || str(record.error)
  if (direct) return direct
  const nested = isPlainObject(record.error) ? record.error : null
  return nested ? str(nested.message) : ''
}

/**
 * Codex's `exec --json`: JSONL where the payload sits under `msg` (older
 * builds) or `item` (newer ones). Both are accepted so the adapter survives a
 * CLI upgrade, and unknown record types are ignored rather than failing.
 */
export function codexMapper(): EventMapper {
  return (value) => {
    if (!isPlainObject(value)) return []
    const envelope = str(value.type)
    const item = isPlainObject(value.item) ? value.item : null
    const payload = isPlainObject(value.msg) ? value.msg : (item ?? value)
    const type = str(payload.type) || envelope

    /*
     * Fatal errors arrive on the envelope (`{"type":"error"}`, `turn.failed`)
     * or, on older builds, under `msg`.
     *
     * An error nested in `item` is a different thing: codex reports
     * "Model metadata for `x` not found. Defaulting to fallback metadata" as
     * `{"type":"item.completed","item":{"type":"error",...}}` and then runs the
     * turn to completion. Throwing on that killed runs that would have
     * succeeded, so item-level errors stay visible without ending the turn —
     * a genuinely fatal one still announces itself on the envelope.
     */
    if (envelope === 'error' || envelope === 'stream_error' || envelope === 'turn.failed') {
      throw new Error(codexError(payload) || codexError(value) || 'codex reported an error')
    }
    if (type === 'error' || type === 'stream_error') {
      const detail = codexError(payload)
      if (!item) throw new Error(detail || 'codex reported an error')
      return detail ? [{ type: 'reasoning', delta: `⚠ ${detail}\n` }] : []
    }

    const text = str(payload.delta) || str(payload.message) || str(payload.text)
    if (!text) return []

    if (type.startsWith('agent_reasoning') || type === 'reasoning') {
      return [{ type: 'reasoning', delta: text }]
    }
    if (type.startsWith('agent_message') || type === 'assistant_message') {
      return [{ type: 'text', delta: text }]
    }
    return []
  }
}

/**
 * pi's `--mode json`: lifecycle records plus `message_update` envelopes whose
 * `assistantMessageEvent` carries the incremental text and thinking.
 */
/** pi reports usage on the finished message: `{ input, output, totalTokens }`. */
function piUsage(value: Record<string, unknown>): ChatChunk[] {
  const message = isPlainObject(value.message) ? value.message : null
  const usage = message && isPlainObject(message.usage) ? message.usage : null
  if (!usage) return []
  const num = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  return [
    {
      type: 'usage',
      usage: {
        inputTokens: num(usage.input),
        outputTokens: num(usage.output),
        totalTokens: num(usage.totalTokens),
        cachedInputTokens: num(usage.cacheRead)
      }
    }
  ]
}

export function piMapper(): EventMapper {
  let terminalError = ''
  return (value) => {
    if (!isPlainObject(value)) return []
    const type = str(value.type)

    if (type === 'error') {
      throw new Error(str(value.message) || str(value.error) || 'pi reported an error')
    }
    /*
     * pi deliberately exits zero after provider failures because its own retry
     * loop handled the process lifecycle. The failure only lives in the JSON
     * envelopes (`stopReason: "error"`, followed by `agent_end`). Treating a
     * zero exit as success turned a real connection/authentication error into
     * an "empty reply" and made the app blame the model for returning nothing.
     * Keep the error while pi retries, and throw only when it says no retry is
     * left; a transient first attempt can still recover normally.
     */
    if (type === 'message_end' || type === 'turn_end') {
      const message = isPlainObject(value.message) ? value.message : null
      if (message && str(message.stopReason) === 'error') {
        terminalError = str(message.errorMessage) || 'pi model request failed'
      }
    }
    if (type === 'agent_end') {
      if (value.willRetry === false && terminalError) throw new Error(terminalError)
      if (value.willRetry !== false) terminalError = ''
      return []
    }
    if (type === 'auto_retry_end' && value.success === false) {
      throw new Error(str(value.finalError) || terminalError || 'pi model request failed')
    }
    if (type === 'message_end' || type === 'turn_end') return piUsage(value)
    if (type !== 'message_update') return []

    const event = isPlainObject(value.assistantMessageEvent) ? value.assistantMessageEvent : null
    if (!event) return []
    const kind = str(event.type)
    const delta = str(event.delta)

    if (kind === 'text_delta' && delta) return [{ type: 'text', delta }]
    if ((kind === 'thinking_delta' || kind === 'reasoning_delta') && delta) {
      return [{ type: 'reasoning', delta }]
    }
    if (kind === 'tool_start' || kind === 'toolCall_start') {
      const name = str(event.name) || str(event.toolName) || 'tool'
      return [{ type: 'reasoning', delta: toolLine(name, event.input ?? event.args) }]
    }
    return []
  }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter(isPlainObject)
    .map((block) => str(block.text) || str(block.content))
    .filter(Boolean)
    .join('')
}

function usageFrom(value: Record<string, unknown>): ChatChunk[] {
  const raw = isPlainObject(value.usage) ? value.usage : null
  if (!raw) return []
  const num = (item: unknown): number | undefined =>
    typeof item === 'number' && Number.isFinite(item) ? item : undefined
  const usage = {
    inputTokens: num(raw.input_tokens) ?? num(raw.inputTokens),
    outputTokens: num(raw.output_tokens) ?? num(raw.outputTokens),
    totalTokens: num(raw.total_tokens) ?? num(raw.totalTokens),
    cachedInputTokens: num(raw.cache_read_input_tokens) ?? num(raw.cachedInputTokens)
  }
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
  ) {
    return []
  }
  return [{ type: 'usage', usage }]
}

function kimiToolLine(call: unknown): string {
  if (!isPlainObject(call)) return toolLine('tool', undefined)
  const fn = isPlainObject(call.function) ? call.function : call
  const name = str(fn.name) || str(call.name) || 'tool'
  let input: unknown = fn.arguments ?? fn.input ?? call.input
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input) as unknown
    } catch {
      // A non-JSON argument string is still worth showing.
    }
  }
  return toolLine(name, input)
}

/** Growing snapshot → only the new suffix. A non-prefix chunk is a fresh delta. */
function diffSnapshot(previous: string, next: string): { full: string; delta: string } {
  if (!next) return { full: previous, delta: '' }
  if (next.startsWith(previous)) return { full: next, delta: next.slice(previous.length) }
  return { full: previous + next, delta: next }
}

function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : textContent(value)
}

/**
 * Incremental thinking/text some Kimi builds emit as Anthropic-style blocks
 * instead of a growing `content` string. Null when this line is not one of those.
 */
function kimiStreamDelta(value: Record<string, unknown>): ChatChunk[] | null {
  const delta = isPlainObject(value.delta) ? value.delta : null
  if (!delta) return null
  const kind = str(delta.type)
  const text = str(delta.text) || str(delta.thinking) || str(delta.reasoning_content)
  if (!text) return null
  if (kind === 'thinking_delta' || kind === 'reasoning_delta') return [{ type: 'reasoning', delta: text }]
  if (kind === 'text_delta' || kind === 'content_delta') return [{ type: 'text', delta: text }]
  return null
}

/**
 * Kimi Code `kimi -p --output-format stream-json`: one JSON object per line.
 * Assistant `content` is a string, sometimes repeated as a growing snapshot.
 * `reasoning_content` / thinking blocks are the same shape and are forwarded
 * as soon as they arrive — the answer is not held back for them.
 * Tool calls use the OpenAI `tool_calls` shape. The closing `meta` line carries
 * the session id (`kimi --session`) for the next turn.
 */
export function kimiMapper(onSession?: (id: string) => void): EventMapper {
  let assistant = ''
  let thought = ''
  return (value) => {
    if (!isPlainObject(value)) return []
    const type = str(value.type)
    const role = str(value.role)

    if (type === 'error' || role === 'error' || value.is_error === true) {
      throw new Error(
        str(value.message) || str(value.error) || textContent(value.content) || 'Kimi Code reported an error'
      )
    }

    if (role === 'meta' || type === 'session.resume_hint') {
      const id = str(value.session_id) || str(value.sessionId)
      if (id) onSession?.(id)
      return []
    }

    // Thinking often arrives before any answer text. Dropping it left the
    // transcript on "Working" with no caret activity until the answer started,
    // which reads as the app being stuck rather than the model thinking.
    const streamed = kimiStreamDelta(value)
    if (streamed) return streamed

    if (type === 'reasoning' || type === 'thinking' || type === 'thought') {
      const data =
        str(value.delta) || str(value.text) || str(value.data) || fieldText(value.reasoning_content)
      return data ? [{ type: 'reasoning', delta: data }] : []
    }

    if (role === 'tool') {
      assistant = ''
      thought = ''
      return []
    }

    if (role !== 'assistant' && type !== 'assistant') return []

    const out: ChatChunk[] = []
    const calls = Array.isArray(value.tool_calls) ? value.tool_calls : []
    for (const call of calls) out.push({ type: 'reasoning', delta: kimiToolLine(call) })

    const reasoning = fieldText(value.reasoning_content) || fieldText(value.reasoning) || fieldText(value.thinking)
    if (reasoning) {
      const next = diffSnapshot(thought, reasoning)
      thought = next.full
      if (next.delta) out.push({ type: 'reasoning', delta: next.delta })
    }

    const content = textContent(value.content)
    if (!content) return out
    const next = diffSnapshot(assistant, content)
    assistant = next.full
    if (next.delta) out.push({ type: 'text', delta: next.delta })
    return out
  }
}

/**
 * Official `grok` headless `--output-format streaming-json`: newline-delimited
 * events (`text`, `thought`, `tool_call`, `usage`, `end`, `error`). `end`
 * carries the session id for `--resume`.
 */
export function grokMapper(onSession?: (id: string) => void): EventMapper {
  return (value) => {
    if (!isPlainObject(value)) return []
    const type = str(value.type)

    if (type === 'error') {
      throw new Error(str(value.message) || str(value.error) || 'Grok reported an error')
    }

    if (type === 'end') {
      const id = str(value.sessionId) || str(value.session_id)
      if (id) onSession?.(id)
      return usageFrom(value)
    }

    if (type === 'usage') return usageFrom(value)

    if (type === 'text') {
      const data = str(value.data) || str(value.text)
      return data ? [{ type: 'text', delta: data }] : []
    }

    if (type === 'thought') {
      const data = str(value.data) || str(value.text)
      return data ? [{ type: 'reasoning', delta: data }] : []
    }

    if (type === 'tool_call') {
      const name = str(value.toolName) || str(value.title) || 'tool'
      return [{ type: 'reasoning', delta: toolLine(name, value.rawInput) }]
    }

    return []
  }
}
