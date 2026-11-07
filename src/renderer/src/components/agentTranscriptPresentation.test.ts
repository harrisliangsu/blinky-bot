import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../../../shared/types'
import { agentMessageParts } from './agentTranscriptPresentation'

const message = (patch: Partial<Message> = {}): Message => ({ id: 'm', role: 'assistant', content: 'UNCLASSIFIED RAW', createdAt: 1, ...patch })

test('completed commentary remains progress, never becomes answer or raw fallback', () => {
  for (const streaming of [true, false]) {
    const parts = agentMessageParts(message({ streaming, reasoning: 'Recorded reasoning', segments: [{ id: 'p', phase: 'commentary', text: 'Inspecting source' }] }))
    assert.deepEqual(parts, { answer: '', reasoning: 'Recorded reasoning', commentary: 'Inspecting source' })
  }
})

test('streaming and committed answers retain only partial/final phases, without mutating input', () => {
  const value = message({ streaming: true, segments: [
    { id: 'c', phase: 'commentary', text: 'Checking the file' },
    { id: 'a', phase: 'partial_answer', text: 'First result' },
    { id: 'f', phase: 'final_answer', text: 'Final **answer**' }
  ] })
  const before = structuredClone(value)
  assert.deepEqual(agentMessageParts(value), { answer: 'First result\n\nFinal **answer**', reasoning: '', commentary: 'Checking the file' })
  assert.deepEqual(value, before)
})

test('tool/system/internal/UI messages cannot turn raw fields into public text', () => {
  for (const patch of [{ role: 'tool' as const }, { role: 'system' as const }, { internal: true }, { uiOnly: true }]) {
    assert.deepEqual(agentMessageParts(message({ ...patch, reasoning: 'PRIVATE', segments: [{ id: 'f', phase: 'final_answer', text: 'PRIVATE' }] })), { answer: '', reasoning: '', commentary: '' })
  }
  assert.equal(agentMessageParts(message({ streaming: true })).answer, '')
  assert.equal(agentMessageParts(message({ toolCalls: [{ id: 't', name: 'shell', args: {} }] })).answer, '')
})

test('every display channel redacts credentials and strips ACTION protocol from public segments', () => {
  const parts = agentMessageParts(message({ reasoning: 'password=reasoning-secret', segments: [
    { id: 'c', phase: 'commentary', text: 'token=progress-secret\nACTION: private-tool' },
    { id: 'f', phase: 'final_answer', text: 'api_key=answer-secret\nACTION: private-tool' }
  ] }))
  assert.doesNotMatch(JSON.stringify(parts), /reasoning-secret|progress-secret|answer-secret|ACTION/)
  assert.match(parts.reasoning, /redacted|\*\*\*/)
})

test('legacy saved answers, displayContent and user text remain readable', () => {
  assert.equal(agentMessageParts(message({ content: 'Saved legacy answer' })).answer, 'Saved legacy answer')
  assert.equal(agentMessageParts(message({ displayContent: 'Public answer', content: 'PRIVATE RAW' })).answer, 'Public answer')
  assert.equal(agentMessageParts(message({ role: 'user', content: 'User request', reasoning: 'not a user field' })).answer, 'User request')
  assert.equal(agentMessageParts(message({ role: 'user' })).reasoning, '')
})

test('missing reasoning stays absent and commentary is retained once answers arrive', () => {
  const parts = agentMessageParts(message({ segments: [{ id: 'c', phase: 'commentary', text: 'Prior progress' }, { id: 'f', phase: 'final_answer', text: 'Answer' }] }))
  assert.deepEqual(parts, { reasoning: '', commentary: 'Prior progress', answer: 'Answer' })
})
