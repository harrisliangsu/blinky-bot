import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anthropicStyleMapper, codexMapper, grokMapper, kimiMapper, piMapper } from './cli/events.ts'
import { CodexItems, codexNotification } from './cli/codexEvents.ts'
import { opencodeEventChunks } from './cli/opencode.ts'
import { promptedToolStream } from './promptedTools.ts'
import { AsyncQueue } from './asyncQueue.ts'
import { streamOpenAiChat } from './openaiStream.ts'
import { streamAnthropic } from './anthropicStream.ts'
import type { ChatChunk } from './types.ts'
import type { ToolSchema } from '../../shared/types.ts'

const publicText = (chunks: ChatChunk[]): string => chunks.flatMap(chunk => chunk.type === 'text' && (chunk.visible || chunk.segment) ? [chunk.delta] : []).join('')
const event = (value: Record<string, unknown>) => ({ type: 'stream_event', event: value })

test('every supported typed CLI speech source is public without requiring phase', () => {
  const examples = [
    codexNotification('item/agentMessage/delta', { itemId: 'no-phase', delta: 'speech' }, new CodexItems()),
    codexMapper()({ type: 'item.completed', item: { type: 'agent_message', text: 'speech' } }),
    anthropicStyleMapper()({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'speech' }] } }),
    anthropicStyleMapper()({ type: 'message', role: 'assistant', content: 'speech' }),
    piMapper()({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'speech' } }),
    opencodeEventChunks({ type: 'session.next.text.delta', data: { sessionID: 's', delta: 'speech' } }, 's'),
    kimiMapper()({ role: 'assistant', content: 'speech' }),
    grokMapper()({ type: 'text', data: 'speech' })
  ]
  for (const chunks of examples) assert.equal(publicText(chunks), 'speech')
})

test('Claude partial text streams immediately and its completed snapshot does not duplicate it', () => {
  const mapper = anthropicStyleMapper()
  mapper(event({ type: 'message_start', message: { id: 'claude-1', role: 'assistant' } }))
  assert.equal(publicText(mapper(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello' } }))), 'Hello')
  assert.equal(publicText(mapper(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } }))), ' there')
  assert.equal(publicText(mapper({ type: 'assistant', message: { id: 'claude-1', role: 'assistant', content: [{ type: 'text', text: 'Hello there!' }] } })), '!')
  assert.equal(publicText(mapper({ type: 'assistant', message: { id: 'claude-1', role: 'assistant', content: [{ type: 'text', text: 'Hello there!' }] } })), '')
  assert.equal(publicText(mapper({ type: 'assistant', message: { id: 'claude-2', content: [{ type: 'text', text: 'Next reply' }] } })), 'Next reply')
})

test('thinking, tool JSON/output, replayed user messages and unknown events never become public text', () => {
  const claude = anthropicStyleMapper(), codex = new CodexItems()
  const hidden = [
    claude(event({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } })),
    claude(event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"token":"PRIVATE"}' } })),
    claude({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'tool_use', name: 'read', input: { path: 'PRIVATE' } }] } }),
    claude({ type: 'message', role: 'user', content: 'PRIVATE' }),
    claude({ type: 'message', content: 'PRIVATE' }),
    codexNotification('item/reasoning/textDelta', { delta: 'PRIVATE' }, codex),
    codexNotification('item/plan/delta', { delta: 'PRIVATE' }, codex),
    codexNotification('item/completed', { item: { type: 'commandExecution', aggregatedOutput: 'PRIVATE' } }, codex),
    piMapper()({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE' } }),
    opencodeEventChunks({ type: 'session.next.reasoning.delta', data: { sessionID: 's', delta: 'PRIVATE' } }, 's'),
    opencodeEventChunks({ type: 'session.next.text.delta', data: { sessionID: 'other', delta: 'PRIVATE' } }, 's'),
    kimiMapper()({ role: 'tool', content: 'PRIVATE' }),
    kimiMapper()({ role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'tool_result', text: 'PRIVATE' }] }),
    kimiMapper()({ delta: { type: 'text_delta', thinking: 'PRIVATE' } }),
    grokMapper()({ type: 'thought', data: 'PRIVATE' })
  ]
  for (const chunks of hidden) assert.equal(publicText(chunks), '')
  assert.throws(() => claude(event({ type: 'error', error: { message: 'stream failed' } })), /stream failed/)
})

const tools: ToolSchema[] = [{ name: 'read', description: 'read', mutating: false, parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
const frame = '<openbot_tool_call>{"name":"read","arguments":{"path":"PRIVATE"}}</openbot_tool_call>'
async function* chunks(texts: string[]): AsyncGenerator<ChatChunk> { for (const delta of texts) yield { type: 'text', delta, visible: true }; yield { type: 'done' } }

test('prompted tools stream ordinary prose before completion while withholding split tool delimiters', async () => {
  const queue = new AsyncQueue<ChatChunk>()
  const iterator = promptedToolStream(queue, tools)[Symbol.asyncIterator]()
  queue.push({ type: 'text', delta: 'First public sentence.', visible: true })
  const first = await iterator.next()
  assert.equal(publicText([first.value!]), 'First public sentence.')
  queue.push({ type: 'done' }); queue.close()
  for await (const _ of iterator) { /* finish */ }
  for (let split = 0; split <= frame.length; split++) {
    const output: ChatChunk[] = []
    for await (const chunk of promptedToolStream(chunks(['before ', frame.slice(0, split), frame.slice(split), ' after']), tools)) output.push(chunk)
    assert.equal(publicText(output), 'before  after')
    assert.equal(output.filter(chunk => chunk.type === 'tool_call').length, 1)
    assert.ok(!publicText(output).includes('PRIVATE'))
  }
})

test('missing public output stays empty and a broken tool frame never flashes as a reply', async () => {
  const output: ChatChunk[] = []
  for await (const chunk of promptedToolStream((async function* () { yield { type: 'reasoning' as const, delta: 'PRIVATE' }; yield { type: 'done' as const } })(), tools)) output.push(chunk)
  assert.equal(publicText(output), '')
  const partial: ChatChunk[] = []
  await assert.rejects(async () => { for await (const chunk of promptedToolStream(chunks(['public prefix ', '<openbot_tool_call>{"token":"PRIVATE"}']), tools)) partial.push(chunk) }, /invalid tool-call frame/)
  assert.equal(publicText(partial), 'public prefix ')
})

test('API streams publish only typed text and preserve partial speech when the server fails', async () => {
  const previous = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('data: '+JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: 'public' }, { type: 'reasoning', text: 'PRIVATE' }, { type: 'tool_result', text: 'PRIVATE' }], reasoning_content: 'PRIVATE' } }] })+'\n\ndata: '+JSON.stringify({ error: { message: 'API failed' } })+'\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const output: ChatChunk[] = []
    await assert.rejects(async () => { for await (const chunk of streamOpenAiChat({ baseUrl: 'http://127.0.0.1/v1', apiKey: 'test', model: 'test', messages: [], signal: new AbortController().signal })) output.push(chunk) }, /API failed/)
    assert.equal(publicText(output), 'public')
    globalThis.fetch = async () => new Response('data: '+JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic public' } })+'\n\ndata: '+JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } })+'\n\ndata: '+JSON.stringify({ type: 'message_stop' })+'\n\n', { headers: { 'content-type': 'text/event-stream' } })
    const anthropic: ChatChunk[] = []
    for await (const chunk of streamAnthropic({ baseUrl: 'http://127.0.0.1', apiKey: 'test', apiVersion: 'test', body: {}, signal: new AbortController().signal })) anthropic.push(chunk)
    assert.equal(publicText(anthropic), 'anthropic public')
    globalThis.fetch = async () => new Response(JSON.stringify({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'JSON public' }, { type: 'tool_result', text: 'PRIVATE' }, { type: 'tool_use', id: 'c', name: 'read', input: { path: 'PRIVATE' } }
    ] }), { headers: { 'content-type': 'application/json' } })
    const json: ChatChunk[] = []
    for await (const chunk of streamAnthropic({ baseUrl: 'http://127.0.0.1', apiKey: 'test', apiVersion: 'test', body: {}, signal: new AbortController().signal })) json.push(chunk)
    assert.equal(publicText(json), 'JSON public')
    assert.equal(json.filter(chunk => chunk.type === 'tool_call').length, 1)
  } finally { globalThis.fetch = previous }
})
