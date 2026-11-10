import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexThreadCall, codexTurnPrompt, shouldRetryCodexThread, threadIdOf } from './codexThread.ts'

const messages = [
  { role: 'user' as const, content: 'first' },
  { role: 'assistant' as const, content: 'ack' },
  { role: 'user' as const, content: 'second' }
]

test('the first turn starts a thread and a later turn resumes by id only', () => {
  const started = codexThreadCall({ cwd: '/work', model: 'gpt-5' })
  assert.equal(started.method, 'thread/start')
  assert.deepEqual(started.params, { cwd: '/work', model: 'gpt-5' })

  const defaults = codexThreadCall({ cwd: '/work', model: 'default' })
  assert.equal(defaults.params.model, undefined)

  const resumed = codexThreadCall({ threadId: 'thr_123', cwd: '/work', model: 'gpt-5' })
  assert.equal(resumed.method, 'thread/resume')
  assert.deepEqual(resumed.params, { threadId: 'thr_123' })
})

test('a failed resume starts fresh unless the turn was cancelled', () => {
  assert.equal(shouldRetryCodexThread({ hadThread: true, aborted: false }), true)
  assert.equal(shouldRetryCodexThread({ hadThread: true, aborted: true }), false)
  assert.equal(shouldRetryCodexThread({ hadThread: false, aborted: false }), false)
})

test('safety overrides are applied when starting and resuming a thread', () => {
  const safety = { approvalPolicy: 'untrusted' as const, sandbox: 'read-only' as const }
  assert.deepEqual(codexThreadCall({ cwd: '/work', ...safety }).params, { cwd: '/work', ...safety })
  assert.deepEqual(codexThreadCall({ threadId: 'thr_123', ...safety }).params, { threadId: 'thr_123', ...safety })
})

test('thread ids are read from either response shape', () => {
  assert.equal(threadIdOf({ threadId: 'thr_a' }), 'thr_a')
  assert.equal(threadIdOf({ thread: { id: 'thr_b' } }), 'thr_b')
  assert.equal(threadIdOf({ threadId: 'not a thread' }), undefined)
})

test('a new thread is handed the transcript', () => {
  const prompt = codexTurnPrompt(messages, 'no-binding', false)
  assert.match(prompt, /first/)
  assert.match(prompt, /second/)
  assert.match(prompt, /conversation-so-far/)
})
