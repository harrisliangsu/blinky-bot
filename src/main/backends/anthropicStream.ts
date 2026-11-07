/**
 * Anthropic Messages API streaming.
 *
 * Content arrives as indexed blocks: text deltas, `thinking` deltas, and
 * `tool_use` blocks whose input is streamed as partial JSON that only parses
 * once the block stops — the same accumulate-then-parse discipline the
 * OpenAI-compatible path uses.
 */

import { postForStream } from './httpClient'
import { safeJsonParse } from './lenientJson'
import { parseToolArgs } from './toolCallAccumulator'
import { readSse } from './sse'
import type { ChatChunk } from './types'
import { joinUrl } from './urls'

export interface AnthropicStreamOptions {
  baseUrl: string
  apiKey: string
  apiVersion: string
  body: Record<string, unknown>
  signal: AbortSignal
}

interface ContentBlock { type?: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }

interface StreamEvent {
  type?: string
  index?: number
  content_block?: ContentBlock
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  error?: { type?: string; message?: string }
}

interface OpenBlock {
  type: string
  id: string
  name: string
  json: string
}

export async function* streamAnthropic(opts: AnthropicStreamOptions): AsyncGenerator<ChatChunk> {
  const res = await postForStream(
    joinUrl(opts.baseUrl, '/v1/messages'),
    { ...opts.body, stream: true },
    {
      'x-api-key': opts.apiKey,
      'anthropic-version': opts.apiVersion,
      accept: 'text/event-stream'
    },
    opts.signal
  )

  // Compatible providers can ignore stream:true. Their typed content blocks
  // retain the same public-text / thinking / tool boundary as SSE events.
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) {
    const message = safeJsonParse<{ type?: string; role?: string; content?: ContentBlock[]; error?: { message?: string } }>(await res.text())
    if (!message) throw new Error('Unreadable Anthropic response.')
    if (message.error || message.type === 'error') throw new Error(message.error?.message ?? 'Anthropic request failed')
    if (!message.role || message.role === 'assistant') {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) yield { type: 'text', delta: block.text, visible: true }
        else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) yield { type: 'reasoning', delta: block.thinking }
        else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
          const args = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {}
          yield { type: 'tool_call', call: { id: block.id ?? '', name: block.name, args } }
        }
      }
    }
    yield { type: 'done' }
    return
  }

  const blocks = new Map<number, OpenBlock>()

  for await (const event of readSse(res)) {
    const data = safeJsonParse<StreamEvent>(event.data)
    if (!data) continue

    if (data.type === 'error' || data.error) {
      throw new Error(data.error?.message ?? 'Anthropic stream error')
    }

    if (data.type === 'content_block_start' && typeof data.index === 'number') {
      const block = data.content_block
      blocks.set(data.index, {
        type: block?.type ?? 'text',
        id: block?.id ?? '',
        name: block?.name ?? '',
        json: ''
      })
      if (block?.type === 'text' && block.text) yield { type: 'text', delta: block.text, visible: true }
      continue
    }

    if (data.type === 'content_block_delta' && typeof data.index === 'number') {
      const delta = data.delta
      if (!delta) continue
      if (delta.type === 'text_delta' && delta.text) {
        yield { type: 'text', delta: delta.text, visible: true }
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        yield { type: 'reasoning', delta: delta.thinking }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const open = blocks.get(data.index)
        if (open) open.json += delta.partial_json
      }
      continue
    }

    if (data.type === 'content_block_stop' && typeof data.index === 'number') {
      const open = blocks.get(data.index)
      blocks.delete(data.index)
      if (open?.type === 'tool_use' && open.name) {
        yield {
          type: 'tool_call',
          call: { id: open.id, name: open.name, args: parseToolArgs(open.json) }
        }
      }
      continue
    }

    if (data.type === 'message_stop') break
  }

  yield { type: 'done' }
}
