import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBotBinding } from './botBinding.ts'

test('a Bot left on the generic model follows Settings, not a stale CLI', () => {
  const binding = resolveBotBinding(
    { backendId: 'kimi', modelId: 'default' },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      backends: { codex: { defaultModelId: 'gpt-5.1-codex' } }
    }
  )
  assert.equal(binding.followsDefault, true)
  assert.equal(binding.backendId, 'codex')
  assert.equal(binding.modelId, 'gpt-5.1-codex')
})

test('a pinned Bot keeps the model it chose', () => {
  const binding = resolveBotBinding(
    { backendId: 'claude', modelId: 'opus', followsDefault: false, thinking: 'high' },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      defaultThinking: 'low',
      backends: { claude: { defaultModelId: 'sonnet' } }
    }
  )
  assert.equal(binding.backendId, 'claude')
  assert.equal(binding.modelId, 'opus')
  assert.equal(binding.followsDefault, false)
  assert.equal(binding.thinking, 'high')
})

test('a pinned Bot on the generic model uses that CLI’s Settings model', () => {
  const binding = resolveBotBinding(
    { backendId: 'claude', modelId: 'default', followsDefault: false },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      backends: { claude: { defaultModelId: 'sonnet' } }
    }
  )
  assert.equal(binding.backendId, 'claude')
  assert.equal(binding.modelId, 'sonnet')
  assert.equal(binding.followsDefault, false)
})

test('a Bot that follows Settings also takes the default thinking depth', () => {
  const binding = resolveBotBinding(
    { backendId: 'kimi', modelId: 'default', thinking: 'xhigh' },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      defaultThinking: 'medium',
      backends: { codex: { defaultModelId: 'gpt-5.1-codex' } }
    }
  )
  assert.equal(binding.followsDefault, true)
  assert.equal(binding.backendId, 'codex')
  assert.equal(binding.thinking, 'medium')
})
