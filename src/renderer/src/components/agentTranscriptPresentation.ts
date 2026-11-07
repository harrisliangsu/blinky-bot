import type { Message } from '../../../shared/types'
import { visibleAssistantText } from '../lib/messagePresentation'
import { agentText } from './agentTaskPresentation'

/** Execution records keep the source phases, including after completion.
 * Structured commentary is never promoted to an answer or replaced with mixed
 * content. Legacy saved text keeps the existing policy. Main Bot is unchanged. */
export function agentMessageParts(message: Message): { answer: string; reasoning: string; commentary: string } {
  const empty = { answer: '', reasoning: '', commentary: '' }
  if (message.internal || message.uiOnly || message.role === 'system' || message.role === 'tool') return empty
  if (message.role === 'user') return { ...empty, answer: agentText(message.displayContent ?? message.content) }
  const segments = message.segments ?? []
  const answers = segments.filter(part => part.phase === 'partial_answer' || part.phase === 'final_answer')
  const commentary = segments.filter(part => part.phase === 'commentary').map(part =>
    visibleAssistantText({ ...message, streaming: false, segments: [part] })).filter(Boolean).join('\n\n')
  const answer = segments.length
    ? answers.length ? visibleAssistantText({ ...message, segments: answers }) : ''
    : visibleAssistantText(message)
  return { answer: agentText(answer), reasoning: agentText(message.reasoning ?? ''), commentary: agentText(commentary) }
}
