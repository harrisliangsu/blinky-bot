/**
 * Consumes one backend stream and fans it out to the renderer.
 *
 * Owns the delta events for a single assistant message. Whether a model calls tools
 * natively or through the prompted fallback is the adapter's business — by the time
 * chunks arrive here they are already normalised, and agent-CLI adapters deliberately
 * render their own tool activity as text so nothing is executed twice.
 */

import type { Message, ToolCall } from '../../shared/types'
import type { ChatChunk } from './contracts'
import { broadcast, onAgentEvent } from './events'
import { asRecord } from './json'
import { normaliseCall } from './backendGateway'
import { isAbortError } from './errors'
import { agentTraceEntry } from '../backends/cli/agentTrace'
import { noteTiming, type TimingObserver } from '../backends/chatTiming'

export interface StreamTurnInput {
  onTiming?: TimingObserver
  sessionId: string
  messageId: string
  stream: AsyncIterable<ChatChunk>
  signal: AbortSignal
  /** Active model's window, so usage can be shown as a proportion. */
  contextWindow?: number
  /**
   * Called for every chunk that carried something — proof the backend is still
   * working.
   *
   * A supervised turn is bounded by an inactivity clock rather than by total
   * duration, and this is what resets it.
   */
  onActivity?: () => void
  /** Persist a partial executor transcript during long-running work. */
  onCheckpoint?: (partial: { text: string; reasoning: string; calls: ToolCall[]; agentTrace: NonNullable<Message['agentTrace']> }) => Promise<void>
}

export interface StreamTurnResult {
  text: string
  /** Text after the last CLI-owned tool operation, when a boundary is known. */
  displayText?: string
  reasoning: string
  calls: ToolCall[]
  segments?: Message['segments']
  agentTrace?: Message['agentTrace']
  aborted: boolean
  /**
   * The stream failed partway through. Reported rather than thrown so the
   * caller still has whatever was streamed before it broke: a CLI that answers
   * and then dies has said something real, and dropping it would leave the user
   * with an error where half an answer had already appeared on screen.
   */
  error?: unknown
}

/**
 * Did this chunk carry anything at all?
 *
 * Every object used to count, empty ones included: `{ type: 'text', delta: '' }`
 * and types this loop does nothing with. A backend that emits empty keepalives —
 * or one wedged in a loop emitting a no-op — held the twenty-minute idle timeout
 * open indefinitely, which is precisely the case the clock exists to catch.
 */
function carriedContent(chunk: ChatChunk): boolean {
  switch (chunk.type) {
    case 'text':
    case 'reasoning':
      return (chunk.delta ?? '') !== ''
    case 'notice':
      return Boolean(chunk.message)
    case 'tool_call':
      return Boolean(chunk.call)
    case 'agent_trace':
      return true
    case 'usage':
      return Boolean(chunk.usage)
    case 'done':
      return true
    default:
      return false
  }
}

export async function streamAssistantTurn(input: StreamTurnInput): Promise<StreamTurnResult> {
  const { sessionId, messageId, signal } = input

  let text = ''
  let reasoning = ''
  let displayText = ''
  let sawToolActivity = false
  const calls: ToolCall[] = []
  const agentTrace: NonNullable<Message['agentTrace']> = []
  const segments: NonNullable<Message['segments']> = []
  let allSegmented = true
  let aborted = false
  let error: unknown
  const shownNotices = new Set<string>()
  let checkpointAt = 0, checkpointFailed = false
  let checkpointQueue: Promise<void> = Promise.resolve()
  let emittingStreamCall = false
  let visibleEpoch = 0
  let sawPublic = false, sawBody = false

  const checkpoint = (force: boolean): Promise<void> => {
    if (!input.onCheckpoint || (!force && Date.now() - checkpointAt < 1000)) return checkpointQueue
    checkpointAt = Date.now()
    const save = input.onCheckpoint
    checkpointQueue = checkpointQueue.then(async () => {
      try { await save({ text, reasoning, calls: [...calls], agentTrace: [...agentTrace] }) }
      catch {
        if (!checkpointFailed) {
          checkpointFailed = true
          broadcast({ type: 'backend-notice', sessionId, category: 'warning', message: '执行过程暂时无法保存；中断后记录可能不完整。' })
        }
      }
    })
    return checkpointQueue
  }

  // Gateway calls arrive separately from the backend stream. Include both the
  // request and its result in execution sessions, without recording screenshots.
  const unsubscribe = input.onCheckpoint ? onAgentEvent((event) => {
    if (!('sessionId' in event) || event.sessionId !== sessionId || !('messageId' in event) || event.messageId !== messageId) return
    if (event.type === 'tool-call' && !emittingStreamCall) {
      const entry = agentTraceEntry(event.call.id, event.call.name, 'started', event.call.args)
      agentTrace.push(entry)
      broadcast({ type: 'agent-trace', sessionId, messageId, entry })
      void checkpoint(true)
    } else if (event.type === 'tool-result') {
      const entry = agentTraceEntry(event.result.callId, event.result.name, 'completed', { ok: event.result.ok, output: event.result.output })
      agentTrace.push(entry)
      broadcast({ type: 'agent-trace', sessionId, messageId, entry })
      void checkpoint(true)
    }
  }) : undefined

  try {
    for await (const chunk of input.stream) {
      if (signal.aborted) {
        aborted = true
        break
      }
      if (!chunk || typeof chunk !== 'object') continue
      if (carriedContent(chunk)) input.onActivity?.()

      if (chunk.type === 'text') {
        const delta = chunk.delta ?? ''
        if (!delta) continue
        if (/\S/u.test(delta) && (chunk.visible || chunk.segment)) {
          if (!sawPublic) { sawPublic = true; noteTiming(input.onTiming, 'first-public-text') }
          if (!sawBody && chunk.segment?.phase !== 'commentary') { sawBody = true; noteTiming(input.onTiming, 'first-body-text') }
        }
        text += delta
        displayText += delta
        // A provider's public text is an answer. Only an explicit commentary
        // channel is progress; reasoning is never promoted to that channel.
        const segment = chunk.segment ?? (chunk.visible ? { id: `visible-${messageId}-${visibleEpoch}`, phase: 'partial_answer' as const, delta } : undefined)
        if (!segment) allSegmented = false
        else {
          const previous = segments[segments.length - 1]
          if (previous?.id === segment.id) previous.text += segment.delta
          else segments.push({ id: segment.id, phase: segment.phase, text: segment.delta })
        }
        broadcast({ type: 'text-delta', sessionId, messageId, delta, ...(segment ? { segment: { ...segment, text: segments.at(-1)?.text } } : {}) })
        await checkpoint(false)
      } else if (chunk.type === 'reasoning') {
        if (chunk.toolActivity) { sawToolActivity = true; displayText = ''; visibleEpoch++ }
        const delta = chunk.delta ?? ''
        if (!delta) continue
        reasoning += delta
        broadcast({ type: 'reasoning-delta', sessionId, messageId, delta })
        await checkpoint(false)
      } else if (chunk.type === 'agent_trace') {
        agentTrace.push(chunk.entry)
        broadcast({ type: 'agent-trace', sessionId, messageId, entry: chunk.entry })
        await checkpoint(true)
      } else if (chunk.type === 'notice' && chunk.message) {
        // Retry attempts often repeat; keep one connection status per phase.
        // Distinct warnings still surface individually.
        const key = chunk.category === 'warning' ? `${chunk.category}:${chunk.message}` : chunk.category
        if (!shownNotices.has(key)) {
          shownNotices.add(key)
          broadcast({ type: 'backend-notice', sessionId, category: chunk.category, message: chunk.message })
        }
      } else if (chunk.type === 'tool_call' && chunk.call) {
        visibleEpoch++
        const call = normaliseCall(asRecord(chunk.call))
        if (!call.name) continue
        calls.push(call)
        emittingStreamCall = true
        try { broadcast({ type: 'tool-call', sessionId, messageId, call }) } finally { emittingStreamCall = false }
        await checkpoint(true)
      } else if (chunk.type === 'usage' && chunk.usage) {
        // Context accounting from the backend; the UI turns it into a ratio.
        broadcast({
          type: 'token-usage',
          sessionId,
          usage: chunk.usage,
          ...(input.contextWindow ? { contextWindow: input.contextWindow } : {})
        })
      } else if (chunk.type === 'done') {
        break
      }
    }
  } catch (err) {
    error = err
    aborted = signal.aborted || isAbortError(err)
  } finally {
    unsubscribe?.()
    await checkpointQueue
  }

  return { text, reasoning, calls, aborted, error, ...(agentTrace.length ? { agentTrace } : {}), ...(sawToolActivity ? { displayText } : {}), ...(allSegmented && segments.length > 0 ? { segments } : {}) }
}
