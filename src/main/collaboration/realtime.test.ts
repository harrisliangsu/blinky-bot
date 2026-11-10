import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../../shared/types'
import { RoomRealtime } from './realtime.ts'
import { publicRoomMessage, roomHistory } from './history.ts'
const scope = { id: 'room', sessionId: 's', token: 'synthetic' }
test('a reply created before sharing and a queued follow-up stay live through completion', () => {
  const tracker = new RoomRealtime(), assistant: Message = { id: 'a', role: 'assistant', createdAt: 1, content: '', streaming: true }, user: Message = { id: 'u', role: 'user', content: 'queued follow-up', createdAt: 2 }
  const stored = [assistant, user]
  const page = roomHistory(stored, scope, new URLSearchParams())
  assert.equal(page.messages.at(-1)!.id, 'u')
  const live: Message = { ...assistant, content: 'visible streaming reply', segments: [{ id: 'p', phase: 'partial_answer', text: 'visible streaming reply' }] }
  tracker.record({ type: 'message-start', sessionId: 's', message: assistant })
  tracker.record({ type: 'text-delta', sessionId: 's', messageId: 'a', delta: 'visible streaming reply', segment: { id: 'p', phase: 'partial_answer', delta: 'visible streaming reply' } })
  assert.deepEqual(tracker.snapshot('s', stored, [live]).map(m => m.id), ['u', 'a'])
  assert.equal(publicRoomMessage(tracker.snapshot('s', stored, [live]).at(-1)!)!.content, 'visible streaming reply')
  const revision = tracker.revision('s')
  const final = { ...live, streaming: false, content: 'final reply', segments: [{ id: 'p', phase: 'final_answer' as const, text: 'final reply' }] }
  tracker.record({ type: 'message-end', sessionId: 's', messageId: 'a', content: final.content }, 'assistant')
  const change = tracker.changes('s', revision)
  assert.deepEqual(change.changes.map(x => [x.id, x.move]), [['a', true]])
  assert.equal(publicRoomMessage(tracker.snapshot('s', [final, user], []).at(-1)!)!.content, 'final reply')
  // A cursor-only query against the original storage order misses this finalized reply.
  assert.ok(!roomHistory([final, user], scope, new URLSearchParams('after=' + page.history.newerCursor)).messages.some(m => m.id === 'a'))
})
test('private reasoning and other sessions do not advance the public event journal', () => {
  const tracker = new RoomRealtime()
  tracker.record({ type: 'reasoning-delta', sessionId: 's', messageId: 'a', delta: 'PRIVATE' })
  assert.equal(tracker.revision('s'), 0)
  tracker.record({ type: 'run-started', sessionId: 'other' })
  assert.equal(tracker.revision('s'), 0)
  tracker.record({ type: 'message-end', sessionId: 's', messageId: 'hidden', internal: true }, 'assistant')
  assert.equal(tracker.changes('s', 0).changes[0]!.wasPublic, false)
})
test('run completion is separate from message completion; clears require a fresh snapshot', () => {
  const tracker = new RoomRealtime()
  tracker.record({ type: 'message-end', sessionId: 's', messageId: 'a' }, 'assistant')
  const afterMessage = tracker.revision('s')
  tracker.record({ type: 'done', sessionId: 's' })
  assert.equal(tracker.revision('s'), afterMessage + 1)
  tracker.markPublic('s', ['a'])
  tracker.record({ type: 'session-updated', session: { id: 's', messages: [] } as never })
  assert.equal(tracker.changes('s', afterMessage).reset, true)
})
test('a new user message stays after a previously finalized assistant', () => {
  const tracker = new RoomRealtime(), assistant: Message = { id: 'a', role: 'assistant', content: 'answer', createdAt: 1 }, next: Message = { id: 'u', role: 'user', content: 'next', createdAt: 2 }
  tracker.record({ type: 'message-end', sessionId: 's', messageId: 'a' }, 'assistant')
  tracker.record({ type: 'message-start', sessionId: 's', message: next })
  assert.deepEqual(tracker.snapshot('s', [assistant, next], []).map(message => message.id), ['a', 'u'])
  tracker.record({ type: 'text-delta', sessionId: 's', messageId: 'a', delta: 'continued', segment: { id: 'p', phase: 'partial_answer', delta: 'continued' } })
  assert.deepEqual(tracker.snapshot('s', [assistant, next], []).map(message => message.id), ['u', 'a'])
})
test('reaction changes update a known bubble without replaying an acknowledged move', () => {
  const tracker = new RoomRealtime(), message: Message = { id: 'a', role: 'assistant', content: 'public answer', createdAt: 1 }
  tracker.markPublic('s', ['a'], [message])
  tracker.record({ type: 'message-end', sessionId: 's', messageId: 'a' }, 'assistant')
  const acknowledged = tracker.revision('s'), changed = { ...message, reactions: { '👍': ['device'] } }
  tracker.record({ type: 'session-updated', session: { id: 's', messages: [changed] } as never })
  assert.equal(tracker.changes('s', 0).changes[0]!.move, true)
  assert.equal(tracker.changes('s', acknowledged).changes[0]!.move, false)
})
