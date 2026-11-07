/** Transactional session storage. Legacy files are retained by the caller. */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Message, Session } from '../../shared/types'

interface StoredAttachment { dataRef?: string }
interface StoredResult { screenshotRef?: string }
type StoredMessage = Omit<Message, 'attachments' | 'toolResult'> & {
  attachments?: Array<NonNullable<Message['attachments']>[number] & StoredAttachment>
  toolResult?: NonNullable<Message['toolResult']> & StoredResult
}

type TextRow = { value: string }

export class SessionDatabase {
  private db: DatabaseSync
  private readonly attachmentDir: string
  constructor(file: string) {
    this.attachmentDir = join(dirname(file), 'attachments')
    mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(session_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE INDEX IF NOT EXISTS message_order ON messages(session_id,position);
      CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported(id TEXT PRIMARY KEY);
    `)
  }
  close(): void { this.db.close() }
  hasImported(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM imported WHERE id=?').get(id)) }
  has(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) }
  hasMessage(sessionId: string, messageId: string): boolean { return Boolean(this.db.prepare('SELECT id FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId)) }
  ids(): string[] { return this.db.prepare('SELECT id FROM sessions').all().map((row) => String(row.id)) }
  /** Lists never read message JSON. Counts use the session/message index. */
  metadata(): Array<{ session: Omit<Session, 'messages'>; messageCount: number }> {
    return this.db.prepare('SELECT id, metadata, (SELECT count(*) FROM messages WHERE session_id=sessions.id) AS message_count FROM sessions').all().map(row => {
      const session = JSON.parse(String(row.metadata)) as Omit<Session, 'messages'>
      if (session.id !== row.id) throw new Error('Session database identity mismatch.')
      return { session, messageCount: Number(row.message_count) }
    })
  }
  private blob(value: string): string {
    const id = createHash('sha256').update(value).digest('hex')
    const file = join(this.attachmentDir, id)
    if (!existsSync(file)) {
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, value, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, file)
        const dir = openSync(this.attachmentDir, 'r')
        try { fsyncSync(dir) } finally { closeSync(dir) }
      } catch (error) { try { unlinkSync(temporary) } catch { /* no temporary file */ }; throw error }
    } else {
      const existing = readFileSync(file, 'utf8')
      if (createHash('sha256').update(existing).digest('hex') !== id) throw new Error('A saved image is damaged.')
    }
    return id
  }
  private externalize(message: Message): StoredMessage {
    const next: StoredMessage = { ...message }
    if (message.attachments) next.attachments = message.attachments.map((item) => {
      if (item.kind !== 'image' || !item.data) return { ...item }
      const { data, ...rest } = item
      return { ...rest, dataRef: this.blob(data) }
    })
    if (message.toolResult?.screenshot) {
      const { screenshot, ...rest } = message.toolResult
      next.toolResult = { ...rest, screenshotRef: this.blob(screenshot) }
    }
    return next
  }
  /** Atomic metadata, message changes and image writes; no original JSON is removed. */
  put(session: Session, imported = false): Session {
    const ids = new Set<string>()
    for (const message of session.messages) {
      if (!message.id || ids.has(message.id)) throw new Error('Duplicate or missing session message id.')
      ids.add(message.id)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { messages, ...metadata } = session
      this.db.prepare('INSERT INTO sessions(id,metadata) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata').run(session.id, JSON.stringify(metadata))
      const write = this.db.prepare('INSERT INTO messages(session_id,id,position,value) VALUES(?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET position=excluded.position,value=excluded.value WHERE position<>excluded.position OR value<>excluded.value')
      const old = this.db.prepare('SELECT id FROM messages WHERE session_id=?').all(session.id)
      const projected = messages.map((message, position) => {
        const value = this.externalize(message)
        write.run(session.id, message.id, position, JSON.stringify(value))
        return value
      })
      const remove = this.db.prepare('DELETE FROM messages WHERE session_id=? AND id=?')
      for (const row of old) if (!ids.has(String(row.id))) remove.run(session.id, String(row.id))
      if (imported) this.db.prepare('INSERT OR IGNORE INTO imported(id) VALUES(?)').run(session.id)
      this.db.exec('COMMIT')
      return { ...metadata, messages: projected }
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* retain original error */ }; throw error }
  }
  /** Metadata and messages omit image bytes until explicitly requested. */
  get(id: string): Session | null {
    const row = this.db.prepare('SELECT metadata AS value FROM sessions WHERE id=?').get(id) as TextRow | undefined
    if (!row) return null
    const metadata = JSON.parse(row.value) as Omit<Session, 'messages'>
    if (metadata.id !== id) throw new Error('Session database identity mismatch.')
    const messages = this.db.prepare('SELECT value FROM messages WHERE session_id=? ORDER BY position').all(id).map((entry) => JSON.parse(String(entry.value)) as Message)
    return { ...metadata, messages }
  }
  getBlob(ref: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(ref)) return null
    let value: string | null = null
    try { value = readFileSync(join(this.attachmentDir, ref), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      // Compatibility with early SQLite-only development previews.
      const row = this.db.prepare('SELECT value FROM blobs WHERE id=?').get(ref) as TextRow | undefined
      value = row?.value ?? null
    }
    if (!value || createHash('sha256').update(value).digest('hex') !== ref) return null
    return value
  }
  /** Keep import marker on deletion, so an old retained JSON cannot resurrect. */
  delete(id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existed = this.has(id)
      this.db.prepare('INSERT OR IGNORE INTO imported(id) VALUES(?)').run(id)
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id)
      this.db.exec('COMMIT')
      return existed
    } catch (error) { try { this.db.exec('ROLLBACK') } catch { /* retain original error */ }; throw error }
  }
}
