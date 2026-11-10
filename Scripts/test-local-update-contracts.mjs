import assert from 'node:assert/strict'
import test from 'node:test'
import { assertTransportFence, appendOriginalBotReceipt } from './local-update-contracts.mjs'

function fixture() {
  const cfg = { transportTaskId: 'transport', transportTaskSessionId: 'executor', sourceSessionId: 'source', originalBotId: 'lead' }
  const source = { id: 'source', botIds: ['lead', 'other'], activeBotId: 'other', messages: [] }, execution = { id: 'executor', botIds: ['lead'] }
  const task = { id: 'transport', sessionId: 'executor', sourceSessionId: 'source', botId: 'lead', status: 'running' }, bot = { id: 'lead' }
  const suspended = new Set(), cancelled = new Set(), events = []
  const api = { task: () => task, get: id => id === 'source' ? source : id === 'executor' ? execution : null, bot: () => bot, running: () => true, suspended: id => suspended.has(id), cancelled: id => cancelled.has(id), save: value => { Object.assign(source, value); return source }, broadcast: value => events.push(value) }
  return { cfg, source, execution, task, bot, suspended, cancelled, events, api }
}
test('live transport fence pins original owner despite UI selection changing', () => {
  const f = fixture(), proof = assertTransportFence(f.api, f.cfg)
  assert.equal(proof.originalBotId, 'lead'); assert.equal(proof.running, true); assert.equal(proof.stopFlagsClear, true)
  assert.equal(f.source.activeBotId, 'other')
})
test('Stop synchronous flags reject before the still-running task status catches up', () => {
  for (const [set, id] of [['suspended', 'source'], ['suspended', 'executor'], ['cancelled', 'source'], ['cancelled', 'executor']]) {
    const f = fixture(); f[set].add(id)
    assert.equal(f.task.status, 'running'); assert.equal(f.api.running('executor'), true)
    assert.throws(() => assertTransportFence(f.api, f.cfg), /stopped or paused/)
  }
})
test('changed task/session/source/owner and missing executor cannot authorize quit', () => {
  for (const mutate of [f => { f.task.sessionId = 'other' }, f => { f.task.sourceSessionId = 'other' }, f => { f.task.botId = 'other' }, f => { f.task.requesterBotId = 'other' }, f => { f.source.botIds = ['other'] }, f => { f.execution.botIds = ['other'] }, f => { f.bot.archived = true }, f => { f.api.running = () => false }]) {
    const f = fixture(); mutate(f); assert.throws(() => assertTransportFence(f.api, f.cfg))
  }
  for (const status of ['queued', 'cancelled', 'failed', 'completed']) { const f = fixture(); f.task.status = status; assert.throws(() => assertTransportFence(f.api, f.cfg), /no longer running/) }
})
test('receipt uses sealed original author, is idempotent, and never rewrites UI selection', () => {
  const f = fixture(), cfg = { sid: 'source', id: 'receipt', text: 'Measured local delivery.\nFooter sentinel', originalBotId: 'lead' }
  assert.equal(appendOriginalBotReceipt(f.api, cfg).idempotent, false)
  assert.equal(f.source.messages[0].botId, 'lead'); assert.equal(f.source.activeBotId, 'other')
  assert.equal(appendOriginalBotReceipt(f.api, cfg).idempotent, true)
  assert.equal(f.source.messages.length, 1); assert.equal(f.events.length, 1)
})
test('receipt id conflicts require identical body, original author and assistant role', () => {
  for (const change of [{ content: 'Different body' }, { botId: 'other' }, { role: 'user' }]) {
    const f = fixture(), cfg = { sid: 'source', id: 'receipt', text: 'Measured delivery', originalBotId: 'lead' }
    f.source.messages.push({ id: 'receipt', role: 'assistant', content: cfg.text, botId: 'lead', ...change })
    assert.throws(() => appendOriginalBotReceipt(f.api, cfg), /conflicts/)
    assert.equal(f.events.length, 0)
  }
})
test('removed or archived original Bot cannot be replaced by another selected Bot', () => {
  for (const mutate of [f => { f.source.botIds = ['other'] }, f => { f.bot.archived = true }, f => { f.api.bot = () => null }]) {
    const f = fixture(); mutate(f)
    assert.throws(() => appendOriginalBotReceipt(f.api, { sid: 'source', id: 'receipt', text: 'Delivery', originalBotId: 'lead' }), /original Bot is absent/)
    assert.equal(f.source.messages.length, 0); assert.equal(f.events.length, 0)
  }
})
