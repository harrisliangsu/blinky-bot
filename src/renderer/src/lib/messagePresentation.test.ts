import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../../../shared/types'
import { visibleAssistantText, visibleModelProgress } from './messagePresentation.ts'

test('public answers replace transient commentary while streaming and afterward', () => {
  const message: Message = { id: 'a', role: 'assistant', content: 'working\n\nanswer', createdAt: 1, segments: [
    { id: '1', phase: 'commentary', text: 'working' },
    { id: '2', phase: 'final_answer', text: 'answer' }
  ] }
  assert.equal(visibleAssistantText(message), 'answer')
  assert.equal(visibleAssistantText({ ...message, streaming: true }), 'answer')
  assert.equal(visibleAssistantText({ ...message, internal: true }), '')
  assert.equal(visibleAssistantText({ ...message, segments: [{ id: '1', phase: 'commentary', text: 'working' }] }), 'working')
  assert.equal(visibleAssistantText({ ...message, segments: undefined, content: 'ordinary answer' }), 'ordinary answer')
  assert.equal(visibleAssistantText({ ...message, segments: undefined, content: 'internal progressfinal answer', displayContent: 'final answer' }), 'final answer')
  assert.equal(visibleAssistantText({ ...message, segments: undefined, displayContent: '' }), '')
})

test('streaming protocol fragments and internal turns stay hidden', () => {
  const base: Message = { id: 'a', role: 'assistant', content: '', createdAt: 1, streaming: true }
  for (const suffix of ['A', 'AC', 'ACTION', 'ACTION:', '**ACTION: ASK teammate']) {
    assert.equal(visibleModelProgress({ ...base, segments: [{ id: '1', phase: 'commentary', text: `Working\n${suffix}` }] }), 'Working')
  }
  assert.equal(visibleAssistantText({ ...base, content: 'tool output without phase' }), '')
  assert.equal(visibleAssistantText({ ...base, internal: true, segments: [{ id: '1', phase: 'commentary', text: 'private' }] }), '')
  assert.equal(visibleAssistantText({ ...base, streaming: false, segments: [{ id: '1', phase: 'commentary', text: '```\nACTION: example\n```' }] }), '```\nACTION: example\n```')
  assert.equal(visibleModelProgress({ ...base, segments: [{ id: '1', phase: 'commentary', text: 'update' }, { id: '2', phase: 'commentary', text: 'update' }] }), 'update')
})


test('only explicit public commentary can supply progress; private reasoning never does', () => {
  const message: Message = { id: 'a', role: 'assistant', content: '', createdAt: 1, streaming: true, reasoning: 'private deliberation' }
  assert.equal(visibleModelProgress(message), '')
  const progress: Message = { ...message, content: 'old update new update', segments: [
    { id: 'old', phase: 'commentary', text: 'old update' },
    { id: 'new', phase: 'commentary', text: 'new update' }
  ] }
  assert.equal(visibleAssistantText(progress), '')
  assert.equal(visibleModelProgress(progress), 'new update')
  for (const override of [{ internal: true }, { uiOnly: true }, { error: 'failed' }, { streaming: false }]) {
    assert.equal(visibleModelProgress({ ...progress, ...override }), '')
  }
  assert.equal(visibleAssistantText({ ...progress, uiOnly: true, streaming: false }), '')
  assert.equal(visibleAssistantText({ ...progress, streaming: false }), 'old update\n\nnew update')
  for (const phase of ['partial_answer', 'final_answer'] as const) {
    const answer = { ...progress, segments: [...progress.segments!, { id: 'answer', phase, text: 'actual answer' }] }
    assert.equal(visibleModelProgress(answer), '')
    assert.equal(visibleAssistantText(answer), 'actual answer')
  }
})

test('long public progress is bounded and preserves literal text without rendering markup', () => {
  const message: Message = { id: 'a', role: 'assistant', content: '', createdAt: 1, streaming: true, segments: [
    { id: 'p', phase: 'commentary', text: '<script>literal</script>\n' + '😀'.repeat(200) }
  ] }
  const progress = visibleModelProgress(message)
  assert.equal(Array.from(progress).length, 161)
  assert.ok(progress.startsWith('<script>literal</script> '))
  assert.ok(progress.endsWith('…'))
})
