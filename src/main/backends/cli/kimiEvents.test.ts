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
      { type: 'text', delta: 'Hi', visible: true }
    ])
    assert.deepEqual(kimi({ delta: { type: 'thinking_delta', thinking: 'more' } }), [
      { type: 'reasoning', delta: 'more' }
    ])
    assert.deepEqual(kimi({ delta: { type: 'text_delta', text: ' there' } }), [{ type: 'text', delta: ' there', visible: true }])
  })

  it('forwards grok thoughts as they stream', () => {
    const grok = grokMapper()
    assert.deepEqual(grok({ type: 'thought', data: 'Looking' }), [{ type: 'reasoning', delta: 'Looking' }])
    assert.deepEqual(grok({ type: 'text', data: 'Hi' }), [{ type: 'text', delta: 'Hi', visible: true }])
  })

  it('records tool activity only for an execution transcript and redacts sensitive fields', () => {
    const call = { type: 'tool_call', id: 'g1', toolName: 'search', rawInput: { query: 'sample', password: 'private-value' } }
    assert.equal(grokMapper()(call).some((chunk) => chunk.type === 'agent_trace'), false)
    const grok = grokMapper(undefined, true)
    const started = grok(call)
    assert.equal(started.filter((chunk) => chunk.type === 'agent_trace').length, 1)
    assert.ok(!JSON.stringify(started).includes('private-value'))
    const result = grok({ type: 'tool_result', id: 'g1', data: { token: 'private-value', output: 'finished' } })
    assert.equal(result[0]?.type, 'agent_trace')
    assert.ok(!JSON.stringify(result).includes('private-value'))
    const kimi = kimiMapper(undefined, true)
    const event = { role: 'assistant', tool_calls: [{ id: 'k1', function: { name: 'read', arguments: '{"password":"private-value"}' } }] }
    assert.equal(kimi(event).filter((chunk) => chunk.type === 'agent_trace').length, 1)
    assert.equal(kimi(event).filter((chunk) => chunk.type === 'agent_trace').length, 0)
    const finished = kimi({ role: 'tool', tool_call_id: 'k1', content: { password: 'private-value', result: 'done' } })
    assert.equal(finished[0]?.type, 'agent_trace')
    assert.ok(!JSON.stringify(finished).includes('private-value'))
  })
})
