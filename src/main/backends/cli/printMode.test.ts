import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatRequest } from '../types.ts'
import { refuseUngovernedSideCall } from './printMode.ts'

const request = (): ChatRequest => ({ model: 'default', messages: [], signal: new AbortController().signal })

test('uncontrolled native tools cannot run in read-only mode or on a private computer', () => {
  assert.doesNotThrow(() => refuseUngovernedSideCall('Kimi', request()))
  assert.throws(() => refuseUngovernedSideCall('Kimi', { ...request(), restrictNativeWrites: true }), /read-only/)
  assert.throws(() => refuseUngovernedSideCall('Grok', { ...request(), disableNativeTools: true }), /private computer/)
  assert.throws(() => refuseUngovernedSideCall('Grok', { ...request(), readOnly: true }), /background side call/)
})
