/** Persist authenticated signals before acknowledging them, with durable deduplication. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataRoot, ensureDir } from '../store/paths'

export interface WebhookSignal { id: string; routineId: string; botId: string; name: string; instruction: string; createdAt: number; status: 'pending' | 'queued' }
const legacyDir = (): string => join(dataRoot(), 'webhook-inbox')
const dbFile = (): string => join(ensureDir(dataRoot()), 'webhook-inbox.sqlite')
let opening: Promise<DatabaseSync> | undefined

function valid(x: unknown): x is WebhookSignal {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const v = x as Record<string, unknown>
  return typeof v.id === 'string' && /^webhook-[a-f0-9]{64}$/.test(v.id) && typeof v.routineId === 'string' && /^[a-f0-9-]{36}$/.test(v.routineId) && typeof v.botId === 'string' && !!v.botId && typeof v.name === 'string' && v.name.length <= 200 && typeof v.instruction === 'string' && v.instruction.length <= 20_000 && typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) && (v.status === 'pending' ? !!v.name && !!v.instruction : v.status === 'queued')
}
function row(db: DatabaseSync, id: string): WebhookSignal | null {
  const value: unknown = db.prepare('SELECT id, routineId, botId, name, instruction, createdAt, status FROM signals WHERE id = ?').get(id)
  if (value === undefined) return null
  if (!valid(value) || value.id !== id) throw new Error('Webhook inbox entry is invalid; it was not changed.')
  return value
}

/** Import legacy JSON atomically, retaining its directory for rollback. */
async function migrateLegacy(db: DatabaseSync): Promise<void> {
  let names: string[]
  try { names = await readdir(legacyDir()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const files = names.filter((name) => /^webhook-[a-f0-9]{64}\.json$/.test(name))
  db.exec('BEGIN IMMEDIATE')
  try {
    const insert = db.prepare('INSERT OR IGNORE INTO signals (id, routineId, botId, name, instruction, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const queued = db.prepare("UPDATE signals SET status = 'queued', name = '', instruction = '' WHERE id = ? AND status = 'pending'")
    for (const name of files) {
      let value: unknown
      try { value = JSON.parse(await readFile(join(legacyDir(), name), 'utf8')) } catch { throw new Error('Webhook inbox entry is damaged; migration was not applied.') }
      if (!valid(value) || value.id !== name.slice(0, -5)) throw new Error('Webhook inbox entry is invalid; migration was not applied.')
      const previous = row(db, value.id)
      if (previous && (previous.routineId !== value.routineId || previous.botId !== value.botId)) throw new Error('Webhook inbox entry conflicts with saved history.')
      insert.run(value.id, value.routineId, value.botId, value.status === 'pending' ? value.name : '', value.status === 'pending' ? value.instruction : '', value.createdAt, value.status)
      if (value.status === 'queued') queued.run(value.id)
    }
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }; throw error }
  // If the app exits after COMMIT but before this rename, importing the same
  // files again is safe: queued records never revert to pending.
  await rename(legacyDir(), join(dataRoot(), `webhook-inbox.migrated-${Date.now()}-${randomUUID()}`))
}

function database(): Promise<DatabaseSync> {
  if (!opening) opening = (async () => {
    const db = new DatabaseSync(dbFile())
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 100; CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, routineId TEXT NOT NULL, botId TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL, createdAt INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'queued'))) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS signals_pending ON signals(status, createdAt)")
      await migrateLegacy(db)
      return db
    } catch (error) { db.close(); throw error }
  })().catch((error) => { opening = undefined; throw error })
  return opening
}

/** Event IDs are sender-assigned and scoped to a routine. Retries never enqueue twice. */
export async function acceptWebhookSignal(routineId: string, botId: string, eventId: string, name: string, instruction: string): Promise<WebhookSignal> {
  if (!/^[a-f0-9-]{36}$/.test(routineId) || !botId || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId) || !name || name.length > 200 || !instruction || instruction.length > 20_000) throw new Error('Invalid webhook event.')
  const id = `webhook-${createHash('sha256').update(`${routineId}\0${eventId}`).digest('hex')}`, db = await database()
  const existing = row(db, id)
  if (existing) {
    if (existing.routineId !== routineId || existing.botId !== botId) throw new Error('Webhook event conflicts with the saved signal.')
    return existing
  }
  const createdAt = Date.now()
  db.prepare("INSERT OR IGNORE INTO signals (id, routineId, botId, name, instruction, createdAt, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')").run(id, routineId, botId, name, instruction, createdAt)
  const saved = row(db, id)
  if (!saved || saved.routineId !== routineId || saved.botId !== botId) throw new Error('Webhook signal could not be saved safely.')
  return saved
}

export async function pendingWebhookSignals(): Promise<WebhookSignal[]> {
  const db = await database(), rows = db.prepare("SELECT id, routineId, botId, name, instruction, createdAt, status FROM signals WHERE status = 'pending' ORDER BY createdAt").all()
  return rows.map((value) => { if (!valid(value)) throw new Error('Webhook inbox contains an invalid pending entry.'); return value })
}

/** Queue execution resolves identity from the authenticated inbox, never message prose. */
export async function getWebhookSignal(id: string): Promise<WebhookSignal | null> {
  if (!/^webhook-[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid webhook signal ID.')
  return row(await database(), id)
}

export async function markWebhookQueued(id: string): Promise<void> {
  if (!/^webhook-[a-f0-9]{64}$/.test(id)) throw new Error('Invalid webhook signal id.')
  const db = await database()
  if (!row(db, id)) throw new Error('The webhook signal disappeared before it was queued.')
  db.prepare("UPDATE signals SET status = 'queued', name = '', instruction = '' WHERE id = ? AND status = 'pending'").run(id)
}
