import type { Message } from './types'

/** Hide multi-bot protocol while it is being typed, including partial prefixes. */
function withoutActionLines(text: string, streaming: boolean): string {
  let fenced = false
  const lines = text.split('\n')
  return lines.filter((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return true }
    if (fenced) return true
    const body = line.replace(/^[\s>*_`#•-]*/, '')
    if (/^ACTION\s*:/i.test(body)) return false
    if (streaming && index === lines.length - 1 && body && 'ACTION'.startsWith(body.toUpperCase())) return false
    if (streaming && index === lines.length - 1 && /^ACTION\s*$/i.test(body)) return false
    return true
  }).join('\n')
}

function publicSegments(message: Message): NonNullable<Message['segments']> {
  return (message.segments ?? []).filter((segment) =>
    segment.phase === 'commentary' || segment.phase === 'partial_answer' || segment.phase === 'final_answer')
}

function segmentText(message: Message, answersOnly: boolean): string {
  const parts: string[] = []
  for (const segment of publicSegments(message)) {
    if (answersOnly && segment.phase === 'commentary') continue
    const value = withoutActionLines(segment.text, Boolean(message.streaming)).trim()
    if (value && value !== parts.at(-1)) parts.push(value)
  }
  return parts.join('\n\n')
}

/** Public answer text. Live commentary has its own transient presentation. */
export function visibleAssistantText(message: Message, includeCommentary = false): string {
  if (message.internal || message.uiOnly || message.role !== 'assistant') return ''
  if (message.segments?.length) {
    // The main chat keeps real public milestones as prose. Its single run
    // indicator is separate, so it never replaces or truncates conversation.
    if (includeCommentary) return segmentText(message, false)
    const answer = segmentText(message, true)
    // A commentary-only response still contains real model output. Once the
    // message ends, keep it readable without leaving an active avatar behind.
    return answer || (!message.streaming ? segmentText(message, false) : '')
  }
  // Unknown source, rather than "missing phase": adapters mark public text
  // `visible`, and stream.ts turns it into partial_answer segments. Keep raw
  // unclassified stdout/protocol out of the live transcript.
  if (message.streaming) return ''
  if (message.displayContent !== undefined) return withoutActionLines(message.displayContent, false)
  if (message.toolCalls?.length) return ''
  return withoutActionLines(message.content, false)
}

/** A short excerpt of explicit public commentary, never raw reasoning. */
export function visibleModelProgress(message: Message): string {
  if (!message.streaming || message.error || message.internal || message.uiOnly || message.role !== 'assistant' || visibleAssistantText(message)) return ''
  const latest = publicSegments(message).filter((part) => part.phase === 'commentary').at(-1)
  if (!latest) return ''
  const text = withoutActionLines(latest.text, true).replace(/\s+/g, ' ').trim()
  const characters = Array.from(text)
  return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : text
}
