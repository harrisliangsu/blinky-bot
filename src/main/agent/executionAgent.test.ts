import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from '../../shared/types.ts'
import { bindExecutionAgent, clearExecutionAgent, setExecutionAgent } from './executionAgent.ts'

test('execution agent inherits its own task management with delegation but cannot redelegate', () => {
  const bot = { systemPrompt: 'Lead', backendId: 'lead', modelId: 'lead-model', tools: ['delegate_task', 'search_gmail', 'read_file'], followsDefault: true } as Bot
  setExecutionAgent('private', { backendId: 'executor', modelId: 'executor-model' })
  try {
    const bound = bindExecutionAgent('private', bot)
    assert.deepEqual(bound.tools, ['search_gmail', 'read_file', 'manage_task'])
    assert.equal(bound.backendId, 'executor')
    assert.equal(bound.modelId, 'executor-model')
    assert.equal(bound.executionAgent, undefined)
    assert.deepEqual(bot.tools, ['delegate_task', 'search_gmail', 'read_file'])
    assert.equal(bindExecutionAgent('unrelated', bot), bot)
    assert.deepEqual(bindExecutionAgent('private', { ...bot, tools: ['read_file'] }).tools, ['read_file'])
  } finally { clearExecutionAgent('private') }
})
