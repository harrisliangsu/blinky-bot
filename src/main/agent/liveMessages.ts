/** Ephemeral, in-process snapshots for viewers joining a running session. */
import type { AgentEvent, Message } from '../../shared/types'

const live = new Map<string, Map<string, Message>>()

export function recordLiveMessage(event: AgentEvent): void {
  if (!('sessionId' in event)) return
  const id = event.sessionId
  if (event.type === 'message-start') {
    if (!event.message.streaming) return
    let messages = live.get(id)
    if (!messages) { messages = new Map(); live.set(id, messages) }
    messages.set(event.message.id, structuredClone(event.message))
  } else if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
    const message = live.get(id)?.get(event.messageId)
    if (!message) return
    if (event.type === 'text-delta') {
      const hadContent = Boolean(message.content)
      message.content += event.delta
      if (event.segment && (message.segments || !hadContent)) {
        const segments = message.segments ??= []
        const last = segments.at(-1)
        if (last?.id === event.segment.id && last.phase === event.segment.phase) last.text += event.segment.delta
        else segments.push({ id: event.segment.id, phase: event.segment.phase, text: event.segment.delta })
      } else if (!event.segment) message.segments = undefined
    }
    else message.reasoning = (message.reasoning ?? '') + event.delta
  } else if (event.type === 'tool-call') {
    const message = live.get(id)?.get(event.messageId)
    if (message && !message.toolCalls?.some((call) => call.id === event.call.id)) message.toolCalls = [...(message.toolCalls ?? []), structuredClone(event.call)]
  } else if (event.type === 'agent-trace') {
    const message = live.get(id)?.get(event.messageId)
    if (message) message.agentTrace = [...(message.agentTrace ?? []), structuredClone(event.entry)]
  } else if (event.type === 'message-end') {
    const messages = live.get(id)
    messages?.delete(event.messageId)
    if (!messages?.size) live.delete(id)
  } else if (event.type === 'done') live.delete(id)
}

export function liveMessages(sessionId: string): Message[] {
  return structuredClone([...live.get(sessionId)?.values() ?? []])
}
