import type { AgentEvent, Message } from '../shared/types'
/** One terminal notification per successful turn, based on durably committed public text. */
export class ReplyCompletion {
  private runs = new Map<string, { messageId?: string; failed: boolean }>()
  private delivered = new Set<string>()
  observe(event: AgentEvent, readMessage: (sessionId: string, messageId: string) => Message | undefined): string | null {
    if (!('sessionId' in event)) return null
    const id = event.sessionId
    if (event.type === 'run-started') {
      this.runs.delete(id); this.runs.set(id, { failed: false })
      if (this.runs.size > 1000) this.runs.delete(this.runs.keys().next().value!)
    }
    const run = this.runs.get(id)
    if (!run) return null
    if (event.type === 'error') run.failed = true
    if (event.type === 'message-end') {
      const message = readMessage(id, event.messageId)
      if (message?.role === 'assistant' && !message.internal && !message.error && (message.displayContent ?? message.content).trim()
        && (!message.segments?.length || message.segments.some(s => s.phase !== 'commentary' && s.text.trim()))) run.messageId = message.id
    }
    if (event.type !== 'done') return null
    this.runs.delete(id)
    if (event.outcome !== 'completed' || run.failed || !run.messageId) return null
    const key = `${id}:${run.messageId}`
    if (this.delivered.has(key)) return null
    this.delivered.add(key)
    if (this.delivered.size > 1000) this.delivered.delete(this.delivered.values().next().value!)
    return run.messageId
  }
}
