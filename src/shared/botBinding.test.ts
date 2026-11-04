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

test('a pinned Bot stays on its CLI until that CLI has a default model', () => {
  const binding = resolveBotBinding(
    { backendId: 'claude', modelId: 'opus', followsDefault: false },
    { defaultBackendId: 'codex', defaultModelId: 'default', backends: { claude: {} } }
  )
  assert.equal(binding.backendId, 'claude')
  assert.equal(binding.modelId, 'opus')
  assert.equal(binding.followsDefault, false)
})

test('the CLI default model is what a pinned Bot runs', () => {
  const binding = resolveBotBinding(
    { backendId: 'claude', modelId: 'opus', followsDefault: false },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      backends: { claude: { defaultModelId: 'sonnet' } }
    }
  )
  assert.equal(binding.backendId, 'claude')
  assert.equal(binding.modelId, 'sonnet')
})
