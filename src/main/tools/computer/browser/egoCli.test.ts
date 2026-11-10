import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runEgoCommand } from './egoCli'

test('reads Ego action receipts without exposing failed command output', async () => {
  const options = { command: process.execPath, args: ['-e', "console.log('__BLINKY_RESULT__'+JSON.stringify({ok:true}))"] }
  assert.deepEqual(await runEgoCommand('', process.env, options), { ok: true })
  await assert.rejects(
    runEgoCommand('private-input', process.env, { command: process.execPath, args: ['-e', "console.error('private-output'); process.exit(1)"] }),
    (error: Error) => !error.message.includes('private-input') && !error.message.includes('private-output')
  )
})

test('terminates an unresponsive Ego process and reports timeout without a receipt', async () => {
  const started = Date.now()
  await assert.rejects(
    runEgoCommand('', process.env, {
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      timeoutMs: 300
    }),
    /timed out/
  )
  assert.ok(Date.now() - started < 4000)
})

test('limits excessive output and identifies a missing executable', async () => {
  await assert.rejects(
    runEgoCommand('', process.env, { command: process.execPath, args: ['-e', "console.log('x'.repeat(10000))"], maxOutput: 100 }),
    /too much data/
  )
  await assert.rejects(runEgoCommand('', process.env, { command: '/nonexistent/blinky-ego-test' }), /unavailable/)
})
