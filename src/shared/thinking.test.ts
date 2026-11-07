import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeModels, runtimeSource } from './botRuntime.ts'
import {
  anthropicThinking,
  codexEffort,
  isThinkingDepth,
  kimiThinkingEnv,
  modelAcceptsThinking,
  openaiReasoningBody,
  openrouterReasoningBody,
  thinkingWire
} from './thinking.ts'
import { thinkingOptions } from './thinking.ts'

test('thinking choices follow the selected model, including its reported default', () => {
  const models = [{ id: 'a', isDefault: true, supportedThinking: ['low', 'max', 'ultra'] as const }, { id: 'b', supportedThinking: ['high'] as const }]
  assert.deepEqual(thinkingOptions('codex', 'default', models), ['low', 'max', 'ultra'])
  assert.deepEqual(thinkingOptions('codex', 'b', models), ['high'])
  assert.deepEqual(thinkingOptions('codex', 'unknown', models), [])
})

test('thinking depth is a closed set', () => {
  assert.equal(isThinkingDepth('high'), true)
  assert.equal(isThinkingDepth('max'), true)
  assert.equal(isThinkingDepth('ultra'), true)
  assert.equal(isThinkingDepth(''), false)
})

test('only backends with a real depth control advertise one', () => {
  assert.equal(thinkingWire('codex'), 'codex')
  assert.equal(thinkingWire('kimi'), 'kimi')
  assert.deepEqual(thinkingOptions('kimi', 'default', []), [])
  assert.deepEqual(thinkingOptions('kimi', 'legacy', [{ id: 'legacy', supportedThinking: ['max'] }]), ['max'])
  assert.equal(thinkingWire('openai'), 'openai')
  assert.equal(thinkingWire('xai'), 'openai')
  assert.equal(thinkingWire('anthropic'), 'anthropic')
  assert.equal(thinkingWire('openrouter'), 'openrouter')
  assert.equal(thinkingWire('claude'), null)
  assert.equal(thinkingWire('grok'), 'grok')
  assert.deepEqual(thinkingOptions('grok', 'default', []), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(thinkingOptions('grok', 'b', [{ id: 'b', supportedThinking: ['high'] }]), ['high'])
  assert.equal(thinkingWire('opencode'), null)
  assert.equal(thinkingWire('pi'), null)
})

test('codex and kimi map the same steps onto their own controls', () => {
  assert.equal(codexEffort(undefined), undefined)
  assert.equal(codexEffort('off'), 'none')
  assert.equal(codexEffort('xhigh'), 'xhigh')
  assert.equal(codexEffort('max'), 'max')
  assert.equal(codexEffort('ultra'), 'ultra')
  assert.equal(kimiThinkingEnv(undefined), undefined)
  assert.deepEqual(kimiThinkingEnv('off'), { KIMI_MODEL_THINKING_EFFORT: 'off' })
  assert.deepEqual(kimiThinkingEnv('high'), { KIMI_MODEL_THINKING_EFFORT: 'high' })
  assert.equal(kimiThinkingEnv('ultra'), undefined)
})

test('openai reasoning effort is sent only to a reasoning model', () => {
  assert.equal(openaiReasoningBody('high', 'gpt-4o', 'openai'), undefined)
  assert.equal(openaiReasoningBody('high', 'default', 'openai'), undefined)
  assert.deepEqual(openaiReasoningBody('low', 'gpt-5.4', 'openai'), { reasoning_effort: 'low' })
  assert.deepEqual(openaiReasoningBody('off', 'o3', 'openai'), { reasoning_effort: 'none' })
  assert.deepEqual(openaiReasoningBody('medium', 'grok-4', 'xai'), { reasoning_effort: 'medium' })
  assert.equal(openaiReasoningBody('high', 'gpt-5.4', 'openrouter'), undefined)
  assert.equal(modelAcceptsThinking('claude', 'opus'), false)
  assert.equal(modelAcceptsThinking('codex', 'default'), true)
})

test('openrouter and anthropic get their own bodies', () => {
  assert.deepEqual(openrouterReasoningBody('high'), { reasoning: { effort: 'high' } })
  assert.deepEqual(openrouterReasoningBody('off'), { reasoning: { effort: 'none' } })
  const high = anthropicThinking('high')
  assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 16_000 })
  assert.equal(high.minMaxTokens, 20_096)
  assert.ok((high.minMaxTokens ?? 0) > (high.thinking?.budget_tokens as number))
  assert.deepEqual(anthropicThinking('off').thinking, { type: 'disabled' })
  assert.deepEqual(anthropicThinking(undefined), {})
  assert.deepEqual(anthropicThinking('ultra'), {})
})

test('a provider id is not treated as a local CLI', () => {
  assert.equal(runtimeSource('codex'), 'cli')
  assert.equal(runtimeSource('openai'), 'provider')
  assert.equal(runtimeSource('ollama', 'local-server'), 'provider')
  assert.equal(runtimeSource('custom', 'agent-cli'), 'cli')
})

test('model choices keep the saved id and a CLI alias', () => {
  const models = runtimeModels('claude', [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }], 'opus')
  assert.deepEqual(
    models.map((model) => model.id),
    ['default', 'opus', 'sonnet', 'haiku', 'claude-sonnet-4-5']
  )
})

test('codex model choices follow the models that CLI reported', () => {
  const models = runtimeModels('codex', [{ id: 'gpt-5.4', label: 'GPT-5.4' }], 'default')
  assert.deepEqual(
    models.map((model) => model.id),
    ['default', 'gpt-5.4']
  )
})
