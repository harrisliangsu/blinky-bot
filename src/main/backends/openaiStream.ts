/** Incremental `/chat/completions` streaming, shared by every OpenAI-compatible backend. */

import { postForStream } from './httpClient'
import { safeJsonParse } from './lenientJson'
import { type OaEndpoint, oaHeaders } from './openaiEndpoint'
import { toOpenAiMessages, toOpenAiTools } from './openaiMessages'
import { readSse } from './sse'
import { ToolCallAccumulator, type OaToolCallDelta } from './toolCallAccumulator'
import type { ChatChunk, ProviderMessage, ToolSchema } from './types'
import { joinUrl } from './urls'

interface OaDelta {
  role?: string
  content?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
  thinking?: unknown
  reasoning_details?: Array<{ text?: string; summary?: string }>
  tool_calls?: OaToolCallDelta[]
}

interface OaChoice {
  index?: number
  delta?: OaDelta
  message?: OaDelta
  finish_reason?: string | null
}

interface OaStreamChunk {
  choices?: OaChoice[]
  error?: { message?: string; type?: string; code?: string } | string
}

export interface OaChatOptions extends OaEndpoint {
  model: string
  messages: ProviderMessage[]
  tools?: ToolSchema[]
  temperature?: number
  signal: AbortSignal
  /** Omit `temperature` for models that reject sampling knobs. */
  allowTemperature?: boolean
}

export async function* streamOpenAiChat(opts: OaChatOptions): AsyncGenerator<ChatChunk> {
  const url = joinUrl(opts.baseUrl, '/chat/completions')
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAiMessages(opts.messages),
    stream: true,
    ...opts.extraBody
  }
  if (typeof opts.temperature === 'number' && opts.allowTemperature !== false) {
    body.temperature = opts.temperature
  }
  if (opts.tools?.length) {
    body.tools = toOpenAiTools(opts.tools)
    body.tool_choice = 'auto'
  }

  const res = await postForStream(url, body, oaHeaders(opts), opts.signal)

  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    yield* wholeResponse(res, url)
    return
  }

  const calls = new ToolCallAccumulator()
  for await (const event of readSse(res)) {
    const data = event.data.trim()
    if (data === '[DONE]') break
    if (!data) continue
    const chunk = safeJsonParse<OaStreamChunk>(data)
    if (!chunk) continue
    if (chunk.error) throw new Error(errorText(chunk.error))
    const choice = chunk.choices?.[0]
    const delta = choice?.delta ?? choice?.message
    if (!delta) continue

    const reasoning = readReasoning(delta)
    if (reasoning) yield { type: 'reasoning', delta: reasoning }
    const content = readContent(delta.content)
    if (content) yield { type: 'text', delta: content, visible: true }
    calls.push(delta.tool_calls)
  }

  for (const call of calls.finish()) yield { type: 'tool_call', call }
  yield { type: 'done' }
}

/** Some servers ignore `stream: true` and answer with a single JSON body. */
async function* wholeResponse(res: Response, url: string): AsyncGenerator<ChatChunk> {
  const text = await res.text()
  const json = safeJsonParse<OaStreamChunk>(text)
  if (!json) throw new Error(`Unreadable response from ${url}: ${text.slice(0, 200)}`)
  if (json.error) throw new Error(errorText(json.error))

  const message = json.choices?.[0]?.message
  if (message) {
    const reasoning = readReasoning(message)
    if (reasoning) yield { type: 'reasoning', delta: reasoning }
    const content = readContent(message.content)
    if (content) yield { type: 'text', delta: content, visible: true }
    const calls = new ToolCallAccumulator()
    calls.push(message.tool_calls)
    for (const call of calls.finish()) yield { type: 'tool_call', call }
  }
  yield { type: 'done' }
}

function readReasoning(d: OaDelta): string {
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) return d.reasoning_content
  if (typeof d.reasoning === 'string' && d.reasoning) return d.reasoning
  if (typeof d.thinking === 'string' && d.thinking) return d.thinking
  if (Array.isArray(d.reasoning_details)) {
    return d.reasoning_details.map((r) => r.text ?? r.summary ?? '').join('')
  }
  return ''
}

function readContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const p = part as { type?: string; text?: unknown }
      return (p.type === 'text' || p.type === 'output_text') && typeof p.text === 'string' ? p.text : ''
    })
    .join('')
}

function errorText(err: OaStreamChunk['error']): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  return err.message ?? err.code ?? err.type ?? 'Unknown error'
}
