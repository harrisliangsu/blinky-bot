import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveBotBinding, snapshotBotBinding } from './botBinding.ts'

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

test('a pinned Bot on the generic model uses the CLI default independently of Settings', () => {
  const binding = resolveBotBinding(
    { backendId: 'claude', modelId: 'default', followsDefault: false },
    {
      defaultBackendId: 'codex',
      defaultModelId: 'default',
      backends: { claude: { defaultModelId: 'sonnet' } }
    }
  )
  assert.equal(binding.backendId, 'claude')
  assert.equal(binding.modelId, 'default')
  assert.equal(binding.followsDefault, false)
})

test('legacy follower retains its effective settings when globals change', () => {
  const old = { defaultBackendId: 'codex', defaultModelId: 'default', defaultThinking: 'high' as const, backends: { codex: { defaultModelId: 'gpt-5.1-codex' } } }
  const frozen = snapshotBotBinding({ backendId: 'kimi', modelId: 'default', followsDefault: true }, old)
  assert.deepEqual(frozen, { backendId: 'codex', modelId: 'gpt-5.1-codex', followsDefault: false, thinking: 'high' })
  assert.deepEqual(resolveBotBinding(frozen, { defaultBackendId: 'claude', defaultModelId: 'opus', backends: { codex: { defaultModelId: 'changed' } } }), frozen)
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

test('connection depth only seeds followers, leaving pinned Bots independent', () => {
  const settings = { defaultBackendId: 'codex', defaultModelId: 'm1', backends: { codex: { defaultModelId: 'm1', modelThinking: { m1: 'ultra' as const, m2: 'low' as const } } } }
  assert.equal(resolveBotBinding({ backendId: 'codex', modelId: 'm1', followsDefault: false }, settings).thinking, undefined)
  assert.equal(resolveBotBinding({ backendId: 'codex', modelId: 'm2', followsDefault: false }, settings).thinking, undefined)
  assert.equal(resolveBotBinding({ backendId: 'codex', modelId: 'm1', followsDefault: false, thinking: 'high' }, settings).thinking, 'high')
  const frozen = snapshotBotBinding({ backendId: 'codex', modelId: 'default', followsDefault: true }, settings)
  assert.equal(frozen.thinking, 'ultra')
  assert.equal(resolveBotBinding(frozen, { ...settings, backends: { codex: { modelThinking: { m1: 'low' } } } }).thinking, 'ultra')
})
