import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { emitTelemetry, flushTelemetry, pruneTelemetry } from './telemetry'

test('emitted events land in events.sqlite in batch and metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-telemetry-'))
  process.env['OPENBOT_DATA_DIR'] = root
  try {
    emitTelemetry({ kind: 'turn.completed', sessionId: 's-1', botId: 'b-1', durationMs: 1200, outcome: 'ok', size: 42 })
    emitTelemetry({ kind: 'queue.steer_ack', sessionId: 's-1' })
    await flushTelemetry()
    const db = new DatabaseSync(join(root, 'events.sqlite'), { readOnly: true })
    const rows = db.prepare('SELECT kind, session_id, duration_ms, outcome, size FROM events ORDER BY seq').all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].kind, 'turn.completed')
    assert.equal(rows[0].duration_ms, 1200)
    assert.equal(rows[1].kind, 'queue.steer_ack')
    db.close()
  } finally {
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('a busy burst flushes in batches without loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-telemetry-drop-'))
  process.env['OPENBOT_DATA_DIR'] = root
  try {
    for (let i = 0; i < 2000; i++) emitTelemetry({ kind: 'test.fill', size: i })
    await flushTelemetry()
    const db = new DatabaseSync(join(root, 'events.sqlite'), { readOnly: true })
    const fills = db.prepare("SELECT COUNT(*) AS n, MIN(size) AS lo, MAX(size) AS hi FROM events WHERE kind = 'test.fill'").get() as { n: number; lo: number; hi: number }
    assert.equal(fills.n, 2000)
    assert.equal(fills.lo, 0)
    assert.equal(fills.hi, 1999)
    db.close()
  } finally {
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('prune removes rows past retention and respects the row cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-telemetry-prune-'))
  process.env['OPENBOT_DATA_DIR'] = root
  try {
    emitTelemetry({ kind: 'test.old' })
    await flushTelemetry()
    const db = new DatabaseSync(join(root, 'events.sqlite'))
    db.prepare('UPDATE events SET at = ?').run(Date.now() - 15 * 24 * 60 * 60 * 1000)
    db.close()
    pruneTelemetry()
    const db2 = new DatabaseSync(join(root, 'events.sqlite'), { readOnly: true })
    assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0)
    db2.close()
  } finally {
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})
