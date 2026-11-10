import type { AgentTaskClarification, Message } from '../../../shared/types'
export type ClarificationEntry = { id: string; messageId: string } | { id: string; request: AgentTaskClarification }
const anchorId = (request: AgentTaskClarification): string => request.anchorMessageId ?? `task-clarification-${request.id}`
/** Preserve stored message order (including backdated timestamps). Prefer the
 * actual notice/message association; timestamps only recover legacy records or
 * remote public pages, where private UI notice anchors are deliberately absent. */
export function clarificationTimeline(messages: Message[], requests: AgentTaskClarification[], hasEarlier: boolean): ClarificationEntry[] {
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  const slots = new Map<number, AgentTaskClarification[]>()
  const unique = new Map<string, AgentTaskClarification>()
  for (const request of requests) {
    const old = unique.get(request.id)
    if (!old || request.updatedAt > old.updatedAt) unique.set(request.id, request)
  }
  for (const request of unique.values()) {
    if (request.status === 'answering' || request.answeredBy === 'bot') continue
    let at = positions.get(anchorId(request))
    if (at === undefined && request.afterMessageId && positions.has(request.afterMessageId)) at = positions.get(request.afterMessageId)! + 1
    if (at === undefined) {
      const time = request.askedAt ?? request.createdAt
      // An old card outside the loaded history must not jump to the bottom.
      if (hasEarlier && (!messages.length || time < messages[0]!.createdAt)) continue
      const following = messages.findIndex(message => message.createdAt > time)
      at = following < 0 ? messages.length : following
    }
    const items = slots.get(at) ?? []; items.push(request); slots.set(at, items)
  }
  const result: ClarificationEntry[] = []
  for (let i = 0; i <= messages.length; i++) {
    for (const request of (slots.get(i) ?? []).sort((a, b) => (a.askedAt ?? a.createdAt) - (b.askedAt ?? b.createdAt) || a.id.localeCompare(b.id))) result.push({ id: `clarification:${request.id}`, request })
    const message = messages[i]
    if (message && !message.id.startsWith('task-clarification-')) result.push({ id: message.id, messageId: message.id })
  }
  return result
}
