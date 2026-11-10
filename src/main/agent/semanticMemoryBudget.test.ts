import assert from 'node:assert/strict'
import {test} from 'node:test'
import {applyBudget, regionHash, type SemanticRegionSummary} from './budget'
import type { HistoryBlock } from './history'
import type { ProviderMessage } from './contracts'

let seq = 0
const block = (text: string, count = 1): HistoryBlock => ({
  // Long enough that the real token estimator puts the fixture over budget.
  messages: Array.from({length: count}, () => ({ role: 'user', content: `${text}: ${'x'.repeat(1800)} #${++seq}` } as ProviderMessage)),
  tokens: 500 * count,
  summary: text
})

const WINDOW = 4000

const fixture = (): HistoryBlock[] => [
  block('opening goal', 1),
  ...Array.from({ length: 6 }, (_, i) => block(`middle detail ${i}`, 1)),
  block('recent state', 2)
]

test('a matching cached semantic summary replaces the extractive one',()=>{
  const blocks = fixture()
  const first = applyBudget(blocks, 50, WINDOW)
  assert.ok(first.omittedHash && first.dropped > 0, 'a region was omitted')
  const semantic: SemanticRegionSummary = { hash: first.omittedHash!, summary: '用户目标：导出并核验。已决定沿用既有成果；遗留时区核验未完成。' }
  const second = applyBudget(blocks, 50, WINDOW, semantic)
  const summary = second.messages.find(m => m.role === 'system' && String(m.content).includes('messages omitted'))
  assert.ok(summary, 'a summary message exists')
  assert.ok(String(summary!.content).includes('时区核验'), 'the semantic summary text is used')
  assert.ok(!String(summary!.content).includes('Condensed record'), 'the extractive lines are replaced')
})

test('a mismatched or absent cache falls back to the extractive summary',()=>{
  const blocks = fixture()
  const wrong = applyBudget(blocks, 50, WINDOW, { hash: 'not-the-region', summary: 'stale' })
  const summary = wrong.messages.find(m => m.role === 'system' && String(m.content).includes('Condensed record'))
  assert.ok(summary, 'extractive fallback keeps the condensed record')
  const none = applyBudget(blocks, 50, WINDOW)
  assert.ok(none.messages.some(m => String(m.content).includes('Condensed record')))
})

test('the region fingerprint is stable and covers the omitted set',()=>{
  const blocks = fixture()
  const a = applyBudget(blocks, 50, WINDOW)
  const b = applyBudget(blocks, 50, WINDOW)
  assert.equal(a.omittedHash, b.omittedHash)
  assert.ok(a.omittedHash, 'a region hash exists')
  const moved = applyBudget([blocks[0], blocks[2], ...blocks.slice(3), blocks[1]], 50, WINDOW)
  assert.notEqual(a.omittedHash, moved.omittedHash)
})

test('omitted text carries role-prefixed content for background summarisation',()=>{
  const blocks = fixture()
  const r = applyBudget(blocks, 50, WINDOW)
  assert.ok(r.omittedText?.includes('user:'), 'role prefix present')
})
