import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mustDelegateTool } from './inlineToolBudget.ts'

test('only the lead application-owned loop is limited after two tool rounds', () => {
  const base={iteration:3,delegated:false,executorConfigured:true,delegationEnabled:true,tool:'shell'}
  assert.equal(mustDelegateTool(base),true)
  assert.equal(mustDelegateTool({...base,iteration:2}),false)
  assert.equal(mustDelegateTool({...base,delegated:true}),false)
  assert.equal(mustDelegateTool({...base,executorConfigured:false}),false)
  assert.equal(mustDelegateTool({...base,delegationEnabled:false}),false)
  for (const tool of ['delegate_task','manage_task','review_task','request_help','recall']) assert.equal(mustDelegateTool({...base,tool}),false)
})
