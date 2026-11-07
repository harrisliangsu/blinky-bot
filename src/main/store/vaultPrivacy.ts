/** Textual transcript projection only; never changes the executable tool call. */
import type { Message } from '../../shared/chat'
import { createVaultTextStream, scrubVaultTextsNow } from './vault'

/** A stopped/checkpointed transcript must not publish an undecided secret prefix. */
export function scrubVaultTranscript(text: string): string {
  const stream = createVaultTextStream<undefined>()
  return [...stream.push(text, undefined), ...stream.finish()].map(part => part.text).join('')
}

/** Tool args/details are JSON data. Images and screenshots are separate boundaries. */
export function scrubVaultJson<T>(value: T): T {
  try {
    const values: string[] = []
    const textual = (item: unknown): boolean => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))
    const serialized = JSON.stringify(value, (_key, item) => { if (textual(item)) values.push(String(item)); return item })
    const checked = scrubVaultTextsNow(values)
    let index = 0
    return JSON.parse(serialized, (_key, item) => {
      if (!textual(item)) return item
      const safe = checked.texts[index++]
      return typeof item === 'number' && safe === String(item) ? item : safe
    }) as T
  } catch { throw new Error('Private output could not be safely checked.') }
}

export function scrubVaultMessage(message: Message): Message {
  const safe = scrubVaultJson({
    content: message.content, displayContent: message.displayContent, reasoning: message.reasoning, error: message.error,
    segments: message.segments?.map(part => part.text), traces: message.agentTrace?.map(entry => entry.detail),
    args: message.toolCalls?.map(call => call.args),
    result: message.toolResult ? { output: message.toolResult.output, detail: message.toolResult.detail } : undefined
  })
  const segments = message.segments?.map(part => ({ ...part, text: '' }))
  if (segments) {
    const stream = createVaultTextStream<number>()
    const append = (parts: Array<{ text: string; context: number }>): void => {
      for (const part of parts) segments[part.context].text += part.text
    }
    message.segments!.forEach((part, i) => append(stream.push(part.text, i)))
    append(stream.finish())
  }
  return {
    ...message,
    content: scrubVaultTranscript(safe.content),
    ...(message.displayContent !== undefined ? { displayContent: scrubVaultTranscript(safe.displayContent!) } : {}),
    ...(message.reasoning !== undefined ? { reasoning: scrubVaultTranscript(safe.reasoning!) } : {}),
    ...(message.error !== undefined ? { error: safe.error } : {}),
    ...(segments ? { segments } : {}),
    ...(message.agentTrace ? { agentTrace: message.agentTrace.map((entry, i) => ({ ...entry, detail: safe.traces![i] })) } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call, i) => ({ ...call, args: safe.args![i] })) } : {}),
    ...(message.toolResult ? { toolResult: { ...message.toolResult, output: safe.result!.output, ...(message.toolResult.detail !== undefined ? { detail: safe.result!.detail } : {}) } } : {})
  }
}
