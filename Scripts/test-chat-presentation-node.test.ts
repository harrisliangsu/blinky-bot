import assert from 'node:assert/strict'
import { test } from 'node:test'
import { store } from '../src/renderer/src/state/core.ts'
import { applyEvent, replayLoadingEvents } from '../src/renderer/src/state/events.ts'
import { visibleAssistantText, visibleModelProgress } from '../src/renderer/src/lib/messagePresentation.ts'
import type { Message } from '../src/shared/types.ts'

// Node-only renderer-store integration: no browser window or Electron is launched.
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {}
} })

const sessionId = 'presentation-integration'
const assistant = (id: string): Message => ({ id, role: 'assistant', content: '', streaming: true, createdAt: 1 })
const user = (id: string, content: string): Message => ({ id, role: 'user', content, createdAt: 1 })
const start = (message: Message): void => applyEvent({ type: 'message-start', sessionId, message })
const delta = (messageId: string, id: string, text: string): void => applyEvent({ type: 'text-delta', sessionId, messageId, delta: text, segment: { id, phase: 'commentary', delta: text } })
const visible = (id: string): string => visibleAssistantText(store.getMessage(id)!) || visibleModelProgress(store.getMessage(id)!)
const reset = (): void => {
  store.resetMessages([])
  store.patch({ currentSessionId: sessionId, messageIds: [], sessionLoading: false, streaming: false })
}

test('multiple messages and live commentary remain in their correct order', () => {
  reset()
  start(user('user-1', 'first question'))
  start(assistant('answer-1'))
  delta('answer-1', 'progress-1', 'checking the first request')
  assert.equal(visible('answer-1'), 'checking the first request')
  applyEvent({ type: 'message-end', sessionId, messageId: 'answer-1', content: 'checking the first request', segments: [{ id: 'progress-1', phase: 'commentary', text: 'checking the first request' }] })
  start(user('user-2', 'second question'))
  start(assistant('answer-2'))
  delta('answer-2', 'progress-2', 'checking the second request')
  assert.deepEqual(store.getState().messageIds, ['user-1', 'answer-1', 'user-2', 'answer-2'])
  assert.equal(visible('answer-1'), 'checking the first request')
  assert.equal(visible('answer-2'), 'checking the second request')
})

test('events buffered while reopening a conversation replay against the loaded snapshot once', () => {
  reset()
  const old = user('old-user', 'previous question')
  store.patch({ sessionLoading: true })
  start(assistant('live-answer'))
  delta('live-answer', 'live-progress', 'resumed progress')
  assert.equal(store.hasMessage('live-answer'), false)
  const ids = store.resetMessages([old])
  store.patch({ messageIds: ids, sessionLoading: false })
  replayLoadingEvents(sessionId)
  assert.deepEqual(store.getState().messageIds, ['old-user', 'live-answer'])
  assert.equal(visible('live-answer'), 'resumed progress')
  replayLoadingEvents(sessionId)
  assert.deepEqual(store.getState().messageIds, ['old-user', 'live-answer'])
  assert.equal(visible('live-answer'), 'resumed progress')
})

test('loading a snapshot that already contains a live message does not duplicate its id', () => {
  reset()
  store.patch({ sessionLoading: true })
  start(assistant('snapshot-answer'))
  applyEvent({ type: 'text-delta', sessionId, messageId: 'snapshot-answer', delta: 'already present', segment: { id: 'snapshot-progress', phase: 'commentary', delta: 'already present', text: 'already present' } })
  const snapshot = { ...assistant('snapshot-answer'), content: 'already present', segments: [{ id: 'snapshot-progress', phase: 'commentary' as const, text: 'already present' }] }
  const ids = store.resetMessages([snapshot])
  store.patch({ messageIds: ids, sessionLoading: false })
  replayLoadingEvents(sessionId)
  store.flushNow()
  assert.deepEqual(store.getState().messageIds, ['snapshot-answer'])
  assert.equal(visible('snapshot-answer'), 'already present')
})
