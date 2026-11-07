import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CdpClient } from './cdpClient'
import { navigate } from './navigation'

test('Chrome navigation surfaces protocol errors and cancels the load wait', async () => {
  let canceled = false
  const cdp = {
    waitFor: (_event: string, _timeout: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      signal.addEventListener('abort', () => { canceled = true; resolve(false) }, { once: true })
    }),
    send: async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' })
  } as unknown as CdpClient
  await assert.rejects(navigate(cdp, 'https://example.invalid'), /ERR_NAME_NOT_RESOLVED/)
  assert.equal(canceled, true)
})
