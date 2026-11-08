import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updateGlassSurface } from './glassPolicy.ts'

test('reduced transparency/contrast, unavailable platforms, disabled preference and bridge failures all use opaque fallback', () => {
  const handle = Buffer.alloc(8), calls: unknown[] = []
  const bridge = { status: () => ({ supported: true, reduced: false }), update: (...args: unknown[]) => { calls.push(args); return true } }
  assert.equal(updateGlassSurface(bridge, handle, 272, true, false).applied, true)
  for (const [candidate, enabled, reduced] of [[null, true, false], [bridge, false, false], [bridge, true, true], [{ ...bridge, status: () => ({ supported: true, reduced: true }) }, true, false], [{ ...bridge, status: () => ({ supported: false, reduced: false }) }, true, false], [{ ...bridge, update: () => { throw Error('Synthetic missing native capability') } }, true, false]] as const) {
    calls.length = 0
    assert.equal(updateGlassSurface(candidate, handle, 272, enabled, true, reduced).applied, false)
    assert.ok(calls.every(args => (args as unknown[])[2] === false))
  }
  assert.equal(updateGlassSurface(bridge, handle, 0, true, false).applied, false)
})
