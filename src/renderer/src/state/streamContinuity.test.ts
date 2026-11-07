import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StateCore } from './core.ts'
import { visibleModelProgress } from '../lib/messagePresentation.ts'
import type { Message } from '../../../shared/types'

test('a session snapshot preserves the live answer while a follow-up is recorded', () => {
  const core = new StateCore()
  const message: Message = { id: 'a', role: 'assistant', content: '', streaming: true, createdAt: 1 }
  core.appendMessage(message)
  core.queueDelta('a', 'text', 'Working', { id: 'seg', phase: 'commentary', delta: 'Working', text: 'Working' })
  const ids = core.resetMessages([{ id: 'u', role: 'user', content: 'status?', createdAt: 2 }], true)
  assert.deepEqual(ids, ['u', 'a'])
  assert.equal(visibleModelProgress(core.getMessage('a')!), 'Working')
  assert.deepEqual(core.resetMessages([{ id: 'a', role: 'assistant', content: 'done', createdAt: 3 }], true), ['a'])
  assert.equal(core.getMessage('a')?.content, 'done')
})

test('replayed segment deltas do not duplicate a live snapshot', () => {
  const core = new StateCore()
  const message: Message = { id: 'a', role: 'assistant', content: 'hello', streaming: true, createdAt: 1, segments: [{ id: 's', phase: 'commentary', text: 'hello' }] }
  core.appendMessage(message)
  core.queueDelta('a', 'text', 'llo', { id: 's', phase: 'commentary', delta: 'llo', text: 'hello' })
  assert.equal(visibleModelProgress(core.getMessage('a')!), 'hello')
  // Force flushing without a browser animation frame.
  ;(globalThis as unknown as { window: unknown }).window = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined }
  core.queueDelta('a', 'text', '!', { id: 's', phase: 'commentary', delta: '!', text: 'hello!' })
  core.flushNow()
  assert.equal(visibleModelProgress(core.getMessage('a')!), 'hello!')
})
