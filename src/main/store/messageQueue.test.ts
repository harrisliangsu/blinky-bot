import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deferQueuedMessage, enqueueExternalMessageOnce, enqueueMessage, finishQueuedMessage, getMessageQueue, loadMessageQueues, markQueuedMessageRecorded, pauseQueueIfNeeded, removeQueuedMessage, returnQueuedMessage, setQueuePaused, startQueuedMessage } from './messageQueue.ts'

test('queued messages persist in order, isolate sessions, and never replay an interrupted run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-queue-test-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    await loadMessageQueues()
    await Promise.all([
      enqueueMessage('a', 'first', []),
      enqueueMessage('a', 'second', []),
      enqueueMessage('b', 'other', [])
    ])
    assert.deepEqual(getMessageQueue('a').items.map((item) => item.text), ['first', 'second'])
    const first = await startQueuedMessage('a')
    assert.equal(first?.text, 'first')
    assert.equal(await startQueuedMessage('a'), null)
    const followup = await startQueuedMessage('a', true)
    assert.equal(followup?.text, 'second')
    await deferQueuedMessage('a', followup!.id)
    assert.equal(getMessageQueue('a').items[1]?.status, 'waiting')
    assert.equal(getMessageQueue('a').paused, false)
    await assert.rejects(removeQueuedMessage('a', first!.id))
    await loadMessageQueues()
    assert.equal(getMessageQueue('a').paused, true)
    assert.equal(getMessageQueue('a').items[0]?.status, 'interrupted')
    await assert.rejects(setQueuePaused('a', false))
    await removeQueuedMessage('a', first!.id)
    await setQueuePaused('a', false)
    const second = await startQueuedMessage('a')
    assert.equal(second?.text, 'second')
    await finishQueuedMessage('a', second!.id, false)
    assert.equal(getMessageQueue('a').items.length, 0)
    assert.equal(getMessageQueue('b').items[0]?.text, 'other')
    const persisted = JSON.parse(await readFile(join(root, 'message-queues.json'), 'utf8'))
    assert.equal(persisted.queues.b.paused, true)
    const pending = enqueueMessage('c', 'during stop', [])
    const stopping = pauseQueueIfNeeded('c')
    await Promise.all([pending, stopping])
    assert.equal(getMessageQueue('c').paused, true)
    await pauseQueueIfNeeded('d')
    await enqueueMessage('d', 'after stop', [], true)
    assert.equal(getMessageQueue('d').paused, true)
    assert.equal(await startQueuedMessage('c'), null)
    await setQueuePaused('c', false)
    const reserved = await startQueuedMessage('c')
    await returnQueuedMessage('c', reserved!.id)
    assert.equal(getMessageQueue('c').items[0]?.status, 'waiting')
    assert.equal(getMessageQueue('c').paused, true)

    // A transcript write does not prove the backend has started; keep a
    // recoverable receipt rather than silently losing it across a crash.
    await enqueueMessage('e', 'durable but not finished', [])
    const recorded = await startQueuedMessage('e')
    await markQueuedMessageRecorded('e', recorded!.id)
    assert.equal(getMessageQueue('e').items[0]?.status, 'processing')
    await assert.rejects(removeQueuedMessage('e', recorded!.id))
    await loadMessageQueues()
    assert.equal(getMessageQueue('e').items[0]?.status, 'interrupted')
    assert.equal(getMessageQueue('e').paused, true)
    assert.equal(await startQueuedMessage('e'), null)
    const externalId = `slack-${'a'.repeat(64)}`
    await Promise.all([enqueueExternalMessageOnce('f',externalId,'channel message','bot'),enqueueExternalMessageOnce('f',externalId,'channel message','bot')])
    assert.equal(getMessageQueue('f').items.length,1)
    assert.equal(getMessageQueue('f').items[0]?.targetBotId,'bot')
    await assert.rejects(enqueueExternalMessageOnce('f',externalId,'different','bot'))
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
