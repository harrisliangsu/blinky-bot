/** One real transport call, text only; no app, user data, shell tool or external send. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runCodexAppServer, steerCodexTurn, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { flushAll } from '../src/main/store/jsonStore.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-real-task-transport-'))
const previous = process.env.OPENBOT_DATA_DIR
process.env.OPENBOT_DATA_DIR = root
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000)
const sessionKey = `task-transport-${randomUUID()}`, started = performance.now()
let output = '', recorded = 0, delivered = false, failure
try {
  const running = (async () => {
    for await (const chunk of runCodexAppServer({ binaryPath: process.env.BLINKY_CODEX_BINARY || `${process.env.HOME}/.local/bin/codex`, ctx: { cwd: root, model: 'default', extraArgs: [] }, req: {
      model: 'default', cwd: root, coordinatorOnly: true, restrictNativeWrites: true, signal: controller.signal, sessionKey,
      messages: [{ role: 'system', content: 'This is a transport verification. Do not call any tools, run commands, inspect files, access URLs, or send anything externally. Only reply to the latest user instruction.' }, { role: 'user', content: 'Reply with only the word INITIAL.' }],
      approve: async () => 'reject'
    } })) if (chunk.type === 'text') output += chunk.delta
  })().catch(error => { failure = error })
  for (let attempt = 0; attempt < 300 && !delivered && !failure; attempt++) {
    delivered = await steerCodexTurn(sessionKey, 'The latest instruction replaces the previous reply. Reply with exactly: TASK-TRANSPORT-ACK', async () => { recorded++ })
    if (!delivered) await new Promise(resolve => setTimeout(resolve, 20))
  }
  await running
  if (failure) throw failure
  assert.equal(delivered, true, 'The active native turn must acknowledge steering')
  assert.equal(recorded, 1, 'Delivery is recorded once')
  assert.match(output, /TASK-TRANSPORT-ACK/)
  const result = { realCodex: true, nativeAppServer: true, nativeSteerAcknowledged: true, receiptRecordedOnce: true, latestInstructionObserved: true, noNativeTools: true, independentUserData: root, elapsedMs: Math.round(performance.now() - started) }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  clearTimeout(timer); controller.abort(); stopWarmCodex(); await flushAll()
  if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = previous
}
