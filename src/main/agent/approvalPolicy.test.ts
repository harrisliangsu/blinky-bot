import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings } from '../settingsSchema.ts'
import { evaluate } from './approvalPolicy.ts'

test('new installations default to auto-run while configured restrictions still apply', () => {
  const settings = defaultSettings()
  assert.equal(settings.approvalPolicy, 'auto-run')
  assert.equal(evaluate(settings, 'shell', 'touch /tmp/example', new Set(), true).outcome, 'ask')
  assert.equal(evaluate(settings, 'shell', 'touch fixture', new Set()).outcome, 'allow')
  assert.equal(evaluate(settings, 'click', '', new Set(), true).outcome, 'ask')
  assert.equal(evaluate(settings, 'fetch', 'https://example.test/send', new Set(), true).outcome, 'ask')
  assert.equal(evaluate(settings, 'read_file', '/outside', new Set(), true).outcome, 'ask')
  assert.equal(evaluate({ ...settings, allowlist: ['tool:click'] }, 'click', '', new Set(), true).outcome, 'ask')
  assert.equal(evaluate(settings, 'write_file', '/outside', new Set(), true).outcome, 'ask')
  assert.equal(evaluate(settings, 'kimi', 'edit fixture', new Set(), true, true).outcome, 'ask')
  assert.equal(evaluate({ ...settings, denylist: ['tool:kimi'] }, 'kimi', 'edit fixture', new Set(), true, true).outcome, 'deny')
  assert.equal(evaluate({ ...settings, denylist: ['blocked'] }, 'shell', 'blocked', new Set()).outcome, 'deny')
  assert.equal(evaluate({ ...settings, approvalPolicy: 'ask-every-time' }, 'shell', 'touch /tmp/example', new Set(), true).outcome, 'ask')
})
