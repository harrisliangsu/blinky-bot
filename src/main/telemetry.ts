/**
 * Local event telemetry for chain auditing and performance work.
 *
 * Design constraints, in order:
 * 1. Never block the caller. `emitTelemetry` only appends to an in-memory
 *    buffer; every database write happens on a timer in a batch.
 * 2. Never lose the app. Emits cannot throw, the buffer drops its oldest
 *    entries under pressure and records how many were dropped.
 * 3. Never leak content. Events carry metadata only — ids, durations,
 *    outcomes and sizes — never message text, paths with user names or
 *    secrets.
 * 4. Never grow forever. Rows older than the retention window (or beyond the
 *    row cap) are pruned at startup and once a day.
 *
 * Streaming deltas are intentionally not events; coarse phases only.
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { dataRoot } from './store/paths'

export interface TelemetryEvent {
  kind: string
  sessionId?: string
  botId?: string
  taskId?: string
  durationMs?: number
  outcome?: string
  size?: number
  /** Short JSON, already bounded by the caller to 1 KiB. */
  detail?: string
}

const BUFFER_CAP = 2000
const FLUSH_MS = 2000
const FLUSH_AT = 400
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const ROW_CAP = 500_000

let buffer: TelemetryEvent[] = []
let dropped = 0
let db: DatabaseSync | null = null
let dbPath: string | null = null
let timer: ReturnType<typeof setInterval> | undefined
let pruneTimer: ReturnType<typeof setInterval> | undefined
let installed = false
const turnStarts = new Map<string, { at: number }>()

function open(): DatabaseSync {
  const path = join(dataRoot(), 'events.sqlite')
  if (db && dbPath === path) return db
  try { db?.close() } catch { /* reopening after a data-root switch */ }
  db = new DatabaseSync(path)
  dbPath = path
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    bot_id TEXT,
    task_id TEXT,
    duration_ms INTEGER,
    outcome TEXT,
    size INTEGER,
    detail TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events(kind, at)')
  return db
}

/** In-memory only. Safe to call from any hot path; never throws. */
export function emitTelemetry(event: TelemetryEvent): void {
  try {
    if (buffer.length >= BUFFER_CAP) { buffer.shift(); dropped++ }
    buffer.push(event)
    if (buffer.length >= FLUSH_AT) void flushTelemetry()
  } catch { /* telemetry must never affect the product */ }
}

export async function flushTelemetry(): Promise<void> {
  const batch = buffer
  if (!batch.length) return
  buffer = []
  const droppedCount = dropped
  dropped = 0
  try {
    const database = open()
    const insert = database.prepare('INSERT INTO events (at, kind, session_id, bot_id, task_id, duration_ms, outcome, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const now = Date.now()
    database.exec('BEGIN')
    try {
      for (const event of batch) {
        insert.run(now, event.kind.slice(0, 80), event.sessionId ?? null, event.botId ?? null, event.taskId ?? null,
          event.durationMs ?? null, event.outcome?.slice(0, 80) ?? null, event.size ?? null, event.detail?.slice(0, 1024) ?? null)
      }
      if (droppedCount) insert.run(now, 'telemetry.dropped', null, null, null, null, null, droppedCount, null)
      database.exec('COMMIT')
    } catch { database.exec('ROLLBACK') }
  } catch { /* a failed flush keeps events out; the next one proceeds */ }
}

/** Prune by retention and row cap. Runs at install and once a day. */
export function pruneTelemetry(): void {
  try {
    const database = open()
    const cutoff = Date.now() - RETENTION_MS
    database.prepare('DELETE FROM events WHERE at < ?').run(cutoff)
    const count = (database.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    if (count > ROW_CAP) database.prepare('DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)').run(ROW_CAP)
  } catch { /* pruning is best effort */ }
}

/** Turn lifecycle from the existing event stream — no per-token events. */
export function installTelemetry(): void {
  if (installed) return
  installed = true
  // Lazy: keep this module's import graph light (node:sqlite + paths only) so
  // the store-level tests can run under strip-only TypeScript too.
  void Promise.all([import('./agent/events'), import('./store/sessions')]).then(([events, sessions]) => {
    events.onAgentEvent((event) => {
      if (event.type === 'run-started') { turnStarts.set(event.sessionId, { at: Date.now() }); return }
      if (event.type !== 'done' && event.type !== 'error') return
      const start = turnStarts.get(event.sessionId)
      turnStarts.delete(event.sessionId)
      const session = sessions.getSession(event.sessionId)
      emitTelemetry({
        kind: 'turn.completed',
        sessionId: event.sessionId,
        botId: session?.activeBotId,
        durationMs: start ? Date.now() - start.at : undefined,
        outcome: event.type === 'error' ? 'error' : 'ok'
      })
    })
  }).catch(() => { /* telemetry never blocks startup */ })
  pruneTelemetry()
  timer = setInterval(() => { void flushTelemetry() }, FLUSH_MS)
  timer.unref?.()
  pruneTimer = setInterval(pruneTelemetry, 24 * 60 * 60 * 1000)
  pruneTimer.unref?.()
}

export async function stopTelemetry(): Promise<void> {
  if (timer) clearInterval(timer)
  if (pruneTimer) clearInterval(pruneTimer)
  timer = undefined
  pruneTimer = undefined
  await flushTelemetry()
  try { db?.close(); db = null; dbPath = null } catch { /* closing is best effort */ }
  installed = false
}
