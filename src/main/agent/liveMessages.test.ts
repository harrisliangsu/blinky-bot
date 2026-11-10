import assert from 'node:assert/strict'
import { test } from 'node:test'
import { liveMessages, recordLiveMessage } from './liveMessages.ts'

test('a late viewer sees the active message and cannot mutate its snapshot', () => {
  const sessionId = 'live-test'
  recordLiveMessage({ type: 'message-start', sessionId, message: { id: 'm1', role: 'assistant', content: '', streaming: true, createdAt: 1 } })
  recordLiveMessage({ type: 'text-delta', sessionId, messageId: 'm1', delta: 'first' })
  recordLiveMessage({ type: 'reasoning-delta', sessionId, messageId: 'm1', delta: 'thinking' })
  recordLiveMessage({ type: 'tool-call', sessionId, messageId: 'm1', call: { id: 'c1', name: 'read_file', args: { path: 'a' } } })
  const first = liveMessages(sessionId)
  assert.equal(first[0]?.content, 'first')
  assert.equal(first[0]?.reasoning, 'thinking')
  assert.equal(first[0]?.toolCalls?.[0]?.name, 'read_file')
  first[0]!.content = 'changed outside'
  recordLiveMessage({ type: 'text-delta', sessionId, messageId: 'm1', delta: ' second' })
  assert.equal(liveMessages(sessionId)[0]?.content, 'first second')
  assert.deepEqual(liveMessages('another-session'), [])
  recordLiveMessage({ type: 'message-end', sessionId, messageId: 'm1' })
  assert.deepEqual(liveMessages(sessionId), [])
})

test('done removes stale live output after interrupted runs', () => {
  recordLiveMessage({ type: 'message-start', sessionId: 'interrupted', message: { id: 'm2', role: 'assistant', content: '', streaming: true, createdAt: 1 } })
  recordLiveMessage({ type: 'done', sessionId: 'interrupted' })
  assert.deepEqual(liveMessages('interrupted'), [])
})

test('live snapshots preserve commentary and final segment boundaries for a returning viewer', () => {
  const sessionId = 'live-segments'
  recordLiveMessage({ type: 'message-start', sessionId, message: { id: 'm', role: 'assistant', content: '', streaming: true, createdAt: 1 } })
  recordLiveMessage({ type: 'text-delta', sessionId, messageId: 'm', delta: 'hello', segment: { id: 's1', phase: 'commentary', delta: 'hello', text: 'hello' } })
  recordLiveMessage({ type: 'text-delta', sessionId, messageId: 'm', delta: ' world', segment: { id: 's1', phase: 'commentary', delta: ' world', text: 'hello world' } })
  recordLiveMessage({ type: 'text-delta', sessionId, messageId: 'm', delta: '\n\nanswer', segment: { id: 's2', phase: 'final_answer', delta: 'answer', text: 'answer' } })
  assert.deepEqual(liveMessages(sessionId)[0]?.segments, [{ id: 's1', phase: 'commentary', text: 'hello world' }, { id: 's2', phase: 'final_answer', text: 'answer' }])
  recordLiveMessage({ type: 'done', sessionId })
})
