/**
 * Kimi stream-json mapping. Thinking has to reach the bubble as it arrives;
 * holding it until `content` is non-empty is a silent wait.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { grokMapper, kimiMapper } from './events.ts'

describe('kimi and grok stream events', () => {
  it('forwards kimi reasoning before the answer, including a growing snapshot', () => {
    const kimi = kimiMapper()
    assert.deepEqual(kimi({ role: 'assistant', reasoning_content: 'Checking', content: '' }), [
      { type: 'reasoning', delta: 'Checking' }
    ])
    assert.deepEqual(kimi({ role: 'assistant', reasoning_content: 'Checking the file', content: 'Hi' }), [
      { type: 'reasoning', delta: ' the file' },
      { type: 'text', delta: 'Hi' }
    ])
    assert.deepEqual(kimi({ delta: { type: 'thinking_delta', thinking: 'more' } }), [
      { type: 'reasoning', delta: 'more' }
    ])
    assert.deepEqual(kimi({ delta: { type: 'text_delta', text: ' there' } }), [{ type: 'text', delta: ' there' }])
  })

  it('forwards grok thoughts as they stream', () => {
    const grok = grokMapper()
    assert.deepEqual(grok({ type: 'thought', data: 'Looking' }), [{ type: 'reasoning', delta: 'Looking' }])
    assert.deepEqual(grok({ type: 'text', data: 'Hi' }), [{ type: 'text', delta: 'Hi' }])
  })
})
