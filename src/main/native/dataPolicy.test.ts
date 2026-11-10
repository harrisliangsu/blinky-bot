import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeDataAllowed } from './dataPolicy.ts'

test('native runtime is confined to a temporary child or the exact packaged Preview store', () => {
  const tmp = '/tmp/blinky'
  const preview = '/Users/example/Library/Application Support/BlinkyBot Preview'
  assert.equal(nativeDataAllowed('/tmp/blinky/snapshot', tmp), true)
  assert.equal(nativeDataAllowed(tmp, tmp), false)
  assert.equal(nativeDataAllowed('/tmp/blinky-other/snapshot', tmp), false)
  assert.equal(nativeDataAllowed(preview, tmp), false)
  assert.equal(nativeDataAllowed(preview, tmp, preview), true)
  assert.equal(nativeDataAllowed('/Users/example/Library/Application Support/BlinkyBot', tmp, preview), false)
  assert.equal(nativeDataAllowed(`${preview}/sessions`, tmp, preview), false)
})
