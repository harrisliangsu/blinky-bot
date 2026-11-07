import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReplyCompletion } from './replyCompletion.ts'
import type { AgentEvent, Message } from '../shared/types'
const message: Message = { id: 'reply', role: 'assistant', content: 'Synthetic reply', createdAt: 1 }
function run(overrides: Partial<Message> = {}) {
  const policy = new ReplyCompletion()
  const event = (e: AgentEvent) => policy.observe(e, () => ({ ...message, ...overrides }))
  event({ type: 'run-started', sessionId: 'chat' })
  event({ type: 'message-end', sessionId: 'chat', messageId: 'reply' })
  return event
}
test('one committed completion, duplicates and stray done are quiet', () => {
  const event = run()
  assert.equal(event({ type: 'done', sessionId: 'chat', outcome: 'completed' }), 'reply')
  assert.equal(event({ type: 'done', sessionId: 'chat', outcome: 'completed' }), null)
  assert.equal(event({ type: 'done', sessionId: 'other', outcome: 'completed' }), null)
})
test('cancellation, failure, ambiguous legacy done and error remain quiet', () => {
  for (const outcome of ['cancelled', 'failed', undefined] as const) assert.equal(run()({ type: 'done', sessionId: 'chat', outcome }), null)
  const event = run(); event({ type: 'error', sessionId: 'chat', message: 'Synthetic error' })
  assert.equal(event({ type: 'done', sessionId: 'chat', outcome: 'completed' }), null)
})
test('empty, user, internal, error and commentary-only messages are quiet', () => {
  for (const change of [{ content: ' ' }, { role: 'user' as const }, { internal: true }, { error: 'failure' }, { segments: [{ id: 's', phase: 'commentary' as const, text: 'working' }] }]) {
    assert.equal(run(change)({ type: 'done', sessionId: 'chat', outcome: 'completed' }), null)
  }
})
test('sessions remain separate and a reused terminal message cannot notify twice', () => {
  const event = run(); assert.equal(event({ type: 'done', sessionId: 'other', outcome: 'completed' }), null)
  assert.equal(event({ type: 'done', sessionId: 'chat', outcome: 'completed' }), 'reply')
  event({ type: 'run-started', sessionId: 'chat' }); event({ type: 'message-end', sessionId: 'chat', messageId: 'reply' })
  assert.equal(event({ type: 'done', sessionId: 'chat', outcome: 'completed' }), null)
})
