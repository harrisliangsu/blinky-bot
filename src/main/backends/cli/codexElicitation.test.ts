import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { allowCoordinatorGatewayCall, answerCodexUserInput } from './codexElicitation'

test('only active coordinator calls to the app gateway reach its authorization checks', () => {
  const context = { coordinator: true, hasGateway: true, active: true, threadId: 'thread', turnId: 'turn' }
  const call = { threadId: 'thread', turnId: 'turn', serverName: 'openbot', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'delegate_task' } }
  assert.equal(allowCoordinatorGatewayCall(call, context), true)
  assert.equal(allowCoordinatorGatewayCall(call, { ...context, active: false }), false)
  assert.equal(allowCoordinatorGatewayCall(call, { ...context, hasGateway: false }), false)
  assert.equal(allowCoordinatorGatewayCall(call, { ...context, coordinator: false }), false)
  assert.equal(allowCoordinatorGatewayCall({ ...call, turnId: 'old' }, context), false)
  assert.equal(allowCoordinatorGatewayCall({ ...call, serverName: 'other' }, context), false)
  assert.equal(allowCoordinatorGatewayCall({ ...call, _meta: { ...call._meta, tool_name: '' } }, context), false)
  assert.equal(allowCoordinatorGatewayCall({ ...call, _meta: { ...call._meta, tool_name: 'review_task' } }, context), true)
})

test('user clarification uses the installed protocol and cannot answer a stale or foreign turn', async () => {
  let active = true, asked = 0
  const context = { active: () => active, threadId: 'thread', turnId: 'turn' }
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [{ id: 'scope', header: '范围', question: '选择哪个目录？', options: [{ label: 'workspace', description: '当前目录' }] }] }
  const ask = async () => { asked++; return { scope: ['workspace'] } }
  assert.deepEqual(JSON.parse(JSON.stringify(await answerCodexUserInput(params, context, ask))), { answers: { scope: { answers: ['workspace'] } } })
  assert.deepEqual(await answerCodexUserInput({ ...params, threadId: 'foreign' }, context, ask), { answers: {} })
  assert.deepEqual(await answerCodexUserInput({ ...params, turnId: 'old' }, context, ask), { answers: {} })
  assert.equal(asked, 1)
  assert.deepEqual(await answerCodexUserInput(params, context, async () => { active = false; return { scope: ['late'] } }), { answers: {} })
  active = true
  assert.deepEqual(await answerCodexUserInput(params, context), { answers: {} })
  assert.deepEqual(await answerCodexUserInput(params, context, async () => ({})), { answers: {} })
})
