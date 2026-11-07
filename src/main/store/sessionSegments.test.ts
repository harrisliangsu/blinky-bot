import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normaliseSession } from './sessionSchema.ts'

test('persisted message segments survive reload only when they preserve the full message', () => {
  const segments = [
    { id: 'a', phase: 'commentary', text: 'Working' },
    { id: 'b', phase: 'final_answer', text: 'Done' }
  ]
  const raw = { id: 'session', botIds: ['bot'], messages: [{ id: 'm', role: 'assistant', content: 'Working\n\nDone', createdAt: 1, segments }] }
  assert.deepEqual(normaliseSession(raw)?.messages[0]?.segments, segments)
  const altered = { ...raw, messages: [{ ...raw.messages[0], content: 'different' }] }
  assert.equal(normaliseSession(altered)?.messages[0]?.segments, undefined)
  assert.equal(normaliseSession(altered)?.messages[0]?.content, 'different')
  const single = { ...raw, messages: [{ ...raw.messages[0], content: 'Working', segments: [segments[0]], displayContent: '' }] }
  assert.deepEqual(normaliseSession(single)?.messages[0]?.segments, [segments[0]])
  assert.equal(normaliseSession(single)?.messages[0]?.displayContent, '')
})

test('executor tool trace survives session reload and invalid entries are rejected', () => {
  const raw = { id: 'session', botIds: ['bot'], messages: [{ id: 'm', role: 'assistant', content: 'Done', createdAt: 1, agentTrace: [{ id: 'c1', kind: 'commandExecution', phase: 'completed', detail: '{"command":"echo ok"}' }, { id: 'bad', kind: 'unknown', phase: 'invented', detail: '' }] }] }
  assert.deepEqual(normaliseSession(raw)?.messages[0]?.agentTrace, [{ id: 'c1', kind: 'commandExecution', phase: 'completed', detail: '{"command":"echo ok"}' }])
})
