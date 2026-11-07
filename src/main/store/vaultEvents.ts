/** Main-only public-event projection. Execution inputs stay in the caller. */
import type { AgentEvent } from '../../shared/types'
import { createVaultTextStream } from './vault'
import { scrubVaultJson, scrubVaultMessage, scrubVaultTranscript } from './vaultPrivacy'

type TextEvent = Extract<AgentEvent, { type: 'text-delta' }>
type ReasoningEvent = Extract<AgentEvent, { type: 'reasoning-delta' }>
type Context = { event: TextEvent; segmentText: boolean }

export function createVaultEventProjection(): (event: AgentEvent) => AgentEvent[] {
  const active = new Map<string, Map<string, {
    text: ReturnType<typeof createVaultTextStream<Context>>
    reasoning: ReturnType<typeof createVaultTextStream<ReasoningEvent>>
    invalidText?: boolean
  }>>()
  const state = (sessionId: string, messageId: string) => {
    let messages = active.get(sessionId)
    if (!messages) active.set(sessionId, messages = new Map())
    let streams = messages.get(messageId)
    if (!streams) messages.set(messageId, streams = { text: createVaultTextStream<Context>(), reasoning: createVaultTextStream<ReasoningEvent>() })
    return streams
  }
  const textEvents = (parts: Array<{ text: string; context: Context }>): AgentEvent[] => parts.map(({ text, context }) => {
    const original = context.event
    return { ...original, delta: text, ...(original.segment ? {
      segment: { id: original.segment.id, phase: original.segment.phase, delta: context.segmentText ? text : '' }
    } : {}) }
  })
  const reasoningEvents = (parts: Array<{ text: string; context: ReasoningEvent }>): AgentEvent[] => parts.map(({ text, context }) => ({ ...context, delta: text }))
  const finish = (sessionId: string, messageId?: string): AgentEvent[] => {
    const messages = active.get(sessionId), output: AgentEvent[] = []
    if (!messages) return output
    for (const [id, streams] of messages) {
      if (messageId !== undefined && id !== messageId) continue
      output.push(...textEvents(streams.text.finish()), ...reasoningEvents(streams.reasoning.finish()))
      messages.delete(id)
    }
    if (!messages.size) active.delete(sessionId)
    return output
  }
  const project = (event: AgentEvent): AgentEvent[] => {
    if (event.type === 'text-delta') {
      const streams = state(event.sessionId, event.messageId), stream = streams.text
      if (streams.invalidText) return []
      if (!event.segment) return textEvents(stream.push(event.delta, { event, segmentText: false }))
      // Codex may prefix a public segment with transcript-only whitespace.
      // Unknown adapter mappings fail closed instead of leaking a second text field.
      if (!event.delta.endsWith(event.segment.delta)) {
        const safe = '[Content withheld: inconsistent stream segment]'
        streams.invalidText = true
        return [...textEvents(stream.finish()), { ...event, delta: safe, segment: { id: event.segment.id, phase: event.segment.phase, delta: safe } }]
      }
      const prefix = event.delta.slice(0, event.delta.length - event.segment.delta.length)
      return textEvents([
        ...stream.push(prefix, { event, segmentText: false }),
        ...stream.push(event.segment.delta, { event, segmentText: true })
      ])
    }
    if (event.type === 'reasoning-delta') return reasoningEvents(state(event.sessionId, event.messageId).reasoning.push(event.delta, event))
    if (event.type === 'message-start') return [...finish(event.sessionId, event.message.id), { ...event, message: scrubVaultMessage(event.message) }]
    if (event.type === 'message-end') {
      const safe = scrubVaultMessage({ id: event.messageId, role: 'assistant', createdAt: 0, content: event.content ?? '', displayContent: event.displayContent, segments: event.segments, toolCalls: event.toolCalls, error: event.error })
      return [...finish(event.sessionId, event.messageId), { ...event, ...(event.content !== undefined ? { content: safe.content } : {}), displayContent: safe.displayContent, segments: safe.segments, toolCalls: safe.toolCalls, error: safe.error }]
    }
    if (event.type === 'done') return [...finish(event.sessionId), event]
    if (event.type === 'error') return [...finish(event.sessionId), { ...event, message: scrubVaultTranscript(event.message) }]
    if (event.type === 'backend-notice') return [{ ...event, message: scrubVaultTranscript(event.message) }]
    if (event.type === 'agent-trace') return [{ ...event, entry: { ...event.entry, ...(event.entry.detail !== undefined ? { detail: scrubVaultTranscript(event.entry.detail) } : {}) } }]
    if (event.type === 'tool-call') return [{ ...event, call: { ...event.call, args: scrubVaultJson(event.call.args) } }]
    if (event.type === 'tool-result') return [{ ...event, result: { ...event.result, output: scrubVaultTranscript(event.result.output), ...(event.result.detail !== undefined ? { detail: scrubVaultJson(event.result.detail) } : {}) } }]
    return [event]
  }
  return event => {
    try { return project(event) }
    catch {
      // Serialization or a faulty adapter must never re-enable the raw event.
      return 'sessionId' in event ? [{ type: 'backend-notice', sessionId: event.sessionId, category: 'warning', message: '[Content withheld: private output could not be checked]' }] : []
    }
  }
}
