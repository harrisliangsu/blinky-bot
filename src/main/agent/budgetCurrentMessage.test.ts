import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applicationContextWindow, applyBudget, inputBudgetFor } from './budget.ts'
import { groupBlocks } from './history.ts'

test('long task context cannot silently replace the latest human request with an ellipsis', () => {
  const request = '总结一下各项任务进展'
  const history = groupBlocks([
    { role: 'user', content: 'Earlier request' },
    { role: 'assistant', content: 'Background '.repeat(9000) },
    { role: 'user', content: request }
  ])
  const result = applyBudget(history, 4500, 8192)
  assert.equal(result.messages.findLast(message => message.role === 'user')?.content, request)
  assert.ok(result.estimatedTokens <= inputBudgetFor(8192))
})

test('oversized instructions fail explicitly instead of silently discarding the request', () => {
  const history = groupBlocks([{ role: 'user', content: '总结一下各项任务进展' }])
  assert.throws(() => applyBudget(history, inputBudgetFor(8192) + 100, 8192), /current message and instructions exceed/)
})

test('Codex without a reported limit does not mistake the generic 8k API fallback for model capacity', () => {
  const history = groupBlocks([{ role: 'user', content: '总结一下各项任务进展' }])
  const systemTokens = 7000
  assert.throws(() => applyBudget(history, systemTokens, 8192))
  const result = applyBudget(history, systemTokens, applicationContextWindow('codex')!)
  assert.equal(result.messages.at(-1)?.content, '总结一下各项任务进展')
  assert.equal(applicationContextWindow('codex', 500000), 32768)
  assert.equal(applicationContextWindow('codex', 4096), 4096)
  assert.equal(applicationContextWindow('api', 4096), 4096)
})
