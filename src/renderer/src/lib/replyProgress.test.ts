import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexItems, codexNotification } from '../../../main/backends/cli/codexEvents.ts'
import { newReplyProgress, reduceReplyProgress, replyProgressLabel } from './replyProgress.ts'
import { visibleAssistantText } from './messagePresentation.ts'
import type { AgentEvent } from '../../../shared/events'

test('Codex native operation start/end maps to progress without inspecting raw detail', () => {
  let state = newReplyProgress()
  const items = new CodexItems()
  for (const [kind, label] of [['webSearch', '正在检索'], ['commandExecution', '正在执行命令'], ['fileChange', '正在修改文件'], ['mcpToolCall', '正在处理工具请求']]) {
    for (const phase of ['started', 'completed']) {
      const chunks = codexNotification(`item/${phase}`, { item: { id: kind, type: kind, command: 'PRIVATE_VALUE', query: 'PRIVATE_QUERY' } }, items, true)
      assert.equal(chunks.length, 1)
      const chunk = chunks[0]
      assert.equal(chunk.type, 'agent_trace')
      if (chunk.type !== 'agent_trace') throw new Error('missing trace')
      state = reduceReplyProgress(state, { type: 'agent-trace', sessionId: 'main', messageId: 'm', entry: chunk.entry }, 'main')
      assert.equal(replyProgressLabel(state, false, true), phase === 'started' ? label : '正在回复')
      assert.doesNotMatch(JSON.stringify([...state.operations]), /PRIVATE/)
    }
  }
})

test('requested tools do not claim execution; results, message-end and terminals are distinct', () => {
  let state = newReplyProgress()
  state = reduceReplyProgress(state, { type: 'tool-call', sessionId: 'main', messageId: 'm', call: { id: 'c', name: 'web_search', args: { query: 'PRIVATE' } } }, 'main')
  assert.equal(replyProgressLabel(state, false, false), 'Handling a tool request')
  assert.equal(replyProgressLabel(state, true, true), '等待确认')
  state = reduceReplyProgress(state, { type: 'message-end', sessionId: 'main', messageId: 'm' }, 'main')
  assert.equal(state.ended, false)
  state = reduceReplyProgress(state, { type: 'tool-result', sessionId: 'main', messageId: 't', result: { callId: 'c', name: 'web_search', ok: false, output: 'denied' } }, 'main')
  assert.equal(replyProgressLabel(state, false, true), '正在回复')
  for (const terminal of [{ type: 'done', sessionId: 'main', outcome: 'cancelled' }, { type: 'error', sessionId: 'main', message: 'failed' }] as AgentEvent[]) {
    const ended = reduceReplyProgress(state, terminal, 'main')
    assert.equal(replyProgressLabel(ended, false, true), '')
    const late = reduceReplyProgress(ended, { type: 'backend-notice', sessionId: 'main', category: 'reconnect', message: 'late' }, 'main')
    assert.equal(late, ended)
    assert.equal(reduceReplyProgress(ended, { type: 'run-started', sessionId: 'main' }, 'main').ended, false)
  }
})

test('parallel tool completions and unrelated background events do not end the foreground reply', () => {
  let state = newReplyProgress()
  for (const id of ['a', 'b']) state = reduceReplyProgress(state, { type: 'agent-trace', sessionId: 'main', messageId: 'm', entry: { id, kind: 'webSearch', phase: 'started', detail: '' } }, 'main')
  state = reduceReplyProgress(state, { type: 'agent-trace', sessionId: 'main', messageId: 'm', entry: { id: 'b', kind: 'webSearch', phase: 'completed', detail: '' } }, 'main')
  assert.equal(replyProgressLabel(state, false, true), '正在检索')
  assert.equal(reduceReplyProgress(state, { type: 'done', sessionId: 'executor' }, 'main'), state)
  assert.equal(reduceReplyProgress(state, { type: 'text-delta', sessionId: 'main', messageId: 'm', delta: 'actual answer', segment: { id: 'a', phase: 'partial_answer', delta: 'actual answer' } }, 'main'), state)
})

test('commentary is preserved as complete public prose, never inferred as an actual operation', () => {
  const message = { id: 'm', role: 'assistant' as const, createdAt: 1, streaming: true, content: '', reasoning: 'PRIVATE', segments: [
    { id: 'c', phase: 'commentary' as const, text: '真实里程碑，后台任务进行中只是引用\nACTION: HIDDEN' },
    { id: 'a', phase: 'partial_answer' as const, text: '公开答案' }
  ] }
  assert.equal(visibleAssistantText(message, true), '真实里程碑，后台任务进行中只是引用\n\n公开答案')
  assert.equal(visibleAssistantText({ ...message, internal: true }, true), '')
  assert.equal(visibleAssistantText({ ...message, uiOnly: true }, true), '')
  assert.equal(visibleAssistantText({ ...message, segments: undefined }, true), '')
  const state = reduceReplyProgress(newReplyProgress(), { type: 'text-delta', sessionId: 'main', messageId: 'm', delta: '我正在查询', segment: { id: 'c', phase: 'commentary', delta: '我正在查询' } }, 'main')
  assert.equal(replyProgressLabel(state, false, true), '正在回复')
})
