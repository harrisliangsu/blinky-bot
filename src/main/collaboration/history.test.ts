import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../../shared/types'
import { roomHistory, RoomHistoryError } from './history.ts'
const room = { id: 'room-one', sessionId: 'session-one', token: 'synthetic-token-only' }
const messages: Message[] = Array.from({ length: 237 }, (_, index) => ({ id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Visible ${index}`, createdAt: index % 3 }))
const page = (query = '', list = messages, scope = room) => roomHistory(list, scope, new URLSearchParams(query))

test('initial two pages and earlier pages preserve stored order despite timestamp ties', () => {
  let current = page()
  assert.deepEqual(current.messages.map(x => x.id), messages.slice(-100).map(x => x.id))
  let ids = current.messages.map(x => x.id)
  while (current.history.hasMore) {
    current = page('before=' + current.history.olderCursor)
    assert.ok(current.messages.length <= 50)
    ids = [...current.messages.map(x => x.id), ...ids]
  }
  assert.deepEqual(ids, messages.map(x => x.id))
  assert.equal(new Set(ids).size, 237)
})
test('concurrent appends do not move older boundaries; polling drains bursts and updates last streaming message', () => {
  const initial = page(), after = initial.history.newerCursor
  const extra: Message[] = Array.from({ length: 230 }, (_, i) => ({ id: 'new-' + i, role: 'assistant', content: 'new public text', createdAt: 0 }))
  const updated = [...messages.slice(0, -1), { ...messages.at(-1)!, content: 'updated last' }, ...extra]
  assert.deepEqual(page('before=' + initial.history.olderCursor, updated).messages, page('before=' + initial.history.olderCursor).messages)
  let tail = page('after=' + after, updated), ids = tail.messages.map(x => x.id)
  assert.equal(tail.messages[0]!.content, 'updated last')
  while (tail.history.hasNewer) { tail = page('after=' + tail.history.newerCursor, updated); ids.push(...tail.messages.map(x => x.id)) }
  assert.deepEqual([...new Set(ids)], [messages.at(-1)!.id, ...extra.map(x => x.id)])
})
test('tool/reasoning/approval payloads and unknown raw stdout never become room prose', () => {
  const list: Message[] = [
    { id: 'hidden', role: 'assistant', content: 'PRIVATE_INTERNAL', internal: true, createdAt: 0 },
    { id: 'approval', role: 'assistant', content: 'PRIVATE_APPROVAL', uiOnly: true, createdAt: 0 },
    { id: 'tool', role: 'tool', content: 'PRIVATE_TOOL', createdAt: 0 },
    { id: 'raw', role: 'assistant', content: 'PRIVATE_RAW_TOOL', toolCalls: [{ id: 'c', name: 'shell', args: {} }], createdAt: 0 },
    { id: 'stream', role: 'assistant', content: 'PRIVATE_RAW_STREAM', streaming: true, createdAt: 0 },
    { id: 'answer', role: 'assistant', content: 'PRIVATE_RAW', reasoning: 'PRIVATE_REASONING', toolResult: { callId: 'c', name: 'shell', ok: true, output: 'PRIVATE_RESULT' }, segments: [{ id: 'p', phase: 'final_answer', text: 'Public answer\nACTION: SECRET' }], createdAt: 0 }
  ]
  assert.deepEqual(page('', list).messages, [{ id: 'answer', role: 'assistant', author: 'BlinkyBot', content: 'Public answer', createdAt: 0, streaming: false }])
  assert.ok(!JSON.stringify(page('', list)).includes('PRIVATE'))
})
test('cursors reject other rooms/sessions, rotated invites, tampering and missing anchors', () => {
  const cursor = page().history.olderCursor!
  for (const scope of [{ ...room, id: 'other' }, { ...room, sessionId: 'other' }, { ...room, token: 'rotated' }]) assert.throws(() => page('before=' + cursor, messages, scope), { status: 400 })
  assert.throws(() => page('before=' + cursor.slice(0, -3) + 'abc'), { status: 400 })
  assert.throws(() => page('before=' + cursor, []), { status: 409 })
  for (const query of ['before=', 'before=x&after=y', 'before=x&before=y']) assert.throws(() => page(query), RoomHistoryError)
})
test('empty and completely hidden history return a valid empty page', () => {
  assert.equal(page('', []).history.hasMore, false)
  assert.deepEqual(page('', []).messages, [])
  assert.equal(page('', []).history.newerCursor, null)
})
