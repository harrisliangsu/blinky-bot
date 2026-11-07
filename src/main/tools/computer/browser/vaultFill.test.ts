import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { vaultFillExpression } from './vaultFill.ts'

test('vault fill requires exact origin and matching focused field, never submits or returns the value', () => {
  class Input {
    type = 'text'; disabled = false; readOnly = false; isConnected = true; hint = ''; events: string[] = []
    private stored = ''
    get value(): string { return this.stored }
    set value(v: string) { this.stored = this.type === 'month' && !/^\d{4}-\d{2}$/.test(v) ? '' : v }
    getAttribute(key: string): string | null { return key === 'autocomplete' ? this.hint : null }
    dispatchEvent(event: { type: string }): boolean { this.events.push(event.type); return true }
  }
  class TestEvent { type: string; constructor(type: string) { this.type = type } }
  const input = new Input(), top = {}, win = { top }
  const context = { location: { origin: 'https://example.test' }, window: win, document: { activeElement: input }, HTMLInputElement: Input, Event: TestEvent }
  win.top = win
  const secret = 'fixture-secret-only'
  input.hint = 'username'
  assert.equal(runInNewContext(vaultFillExpression('https://other.test', 'username', secret), context), false)
  assert.equal(input.value, '')
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'password', secret), context), false)
  input.type = 'password'; input.hint = 'current-password'
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'password', secret), context), true)
  assert.equal(input.value, secret); assert.deepEqual(input.events, ['input', 'change'])
  input.events = []; input.hint = 'one-time-code'; input.value = ''
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'password', secret), context), false)
  assert.equal(input.value, ''); assert.deepEqual(input.events, [])
  assert.throws(() => vaultFillExpression('https://example.test', 'unknown', secret), /Unsupported/)
  class Textarea extends Input {
    override get value(): string { return super.value }
    override set value(v: string) { super.value = v }
  }
  const textarea = new Textarea(); textarea.hint = 'shipping street-address'
  const multilineContext = { ...context, document: { activeElement: textarea }, HTMLTextAreaElement: Textarea }
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'street', 'Fixture street\nUnit 2'), multilineContext), true)
  assert.equal(textarea.value, 'Fixture street\nUnit 2')
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'password', secret), multilineContext), false)
  input.type = 'month'; input.hint = 'cc-exp'
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'expiry', '2030-11'), context), true)
  const eventsBefore = input.events.length
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'expiry', '11/30'), context), false)
  assert.equal(input.value, '2030-11'); assert.equal(input.events.length, eventsBefore)
  input.type = 'email'; input.hint = 'cc-exp'
  input.readOnly = true
  assert.equal(runInNewContext(vaultFillExpression('https://example.test', 'expiry', secret), context), false)
})
