import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryJob, decideMemoryJob, loadMemoryJobs, readMemoryJob, removeMemoryJob, saveMemoryJob } from './memoryQueue.ts'

test('unfinished extraction persists only references and recovers its write boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-memory-queue-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const job = await createMemoryJob({ sessionId: 'session-1', botId: 'bot-1', boundaryId: 'message-1', mode: 'supervised', memoryFingerprint: 'a'.repeat(64) })
    const dir = join(root, 'memory-extraction')
    const names = await readdir(dir)
    assert.equal(names.length, 1)
    const raw = await readFile(join(dir, names[0]), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['botId', 'boundaryId', 'createdAt', 'id', 'memoryFingerprint', 'mode', 'sessionId', 'state'].sort())
    assert.equal((await loadMemoryJobs()).jobs[0].state, 'pending')
    const enabled = { sourceExists: true, boundaryExists: true, enabled: true, fingerprint: job.memoryFingerprint }
    assert.equal(decideMemoryJob(job, enabled), 'run')
    assert.equal(decideMemoryJob(job, { ...enabled, enabled: false }), 'discard')
    assert.equal(decideMemoryJob(job, { ...enabled, boundaryExists: false }), 'discard')
    assert.equal(decideMemoryJob(job, { ...enabled, fingerprint: 'c'.repeat(64) }), 'uncertain')
    job.state = 'writing'
    await saveMemoryJob(job)
    assert.equal((await loadMemoryJobs()).jobs[0].state, 'writing')
    assert.equal(decideMemoryJob(job, enabled), 'uncertain')
    await removeMemoryJob(job)
    assert.equal(await readMemoryJob(job.id), null)
    assert.deepEqual((await loadMemoryJobs()).jobs, [])
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid records are reported instead of becoming recoverable work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-memory-invalid-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const job = await createMemoryJob({ sessionId: 's', botId: 'b', boundaryId: 'm', mode: 'orchestrated', memoryFingerprint: 'b'.repeat(64) })
    const dir = join(root, 'memory-extraction')
    await writeFile(join(dir, 'other.json'), JSON.stringify({ ...job, id: 'different' }))
    const loaded = await loadMemoryJobs()
    assert.equal(loaded.incomplete, true)
    assert.equal(loaded.jobs.length, 1)
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
