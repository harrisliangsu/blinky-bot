/** Session-specific store: incremental transactional messages and lazy images. */
import { closeSync, openSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../../shared/types'
import { dataRoot, ensureDir, safeFileName, sessionsDir } from './paths'
import { normaliseSession } from './sessionSchema'
import { SessionDatabase } from './sessionDatabase'

export class SessionCollection {
  private readonly cache = new Map<string, Session>()
  private readonly metadata = new Map<string, { session: Omit<Session, 'messages'>; messageCount: number }>()
  private db: SessionDatabase | null = null
  private loading: Promise<void> | null = null
  loadWasIncomplete = false

  load(): Promise<void> {
    if (!this.loading) this.loading = this.readAll().catch((error) => { this.loading = null; throw error })
    return this.loading
  }
  private async readAll(): Promise<void> {
    const file = join(ensureDir(dataRoot()), 'sessions.sqlite')
    closeSync(openSync(file, 'a', 0o600))
    const db = new SessionDatabase(file)
    try {
      this.metadata.clear(); this.cache.clear()
      for (const row of db.metadata()) {
        const session = normaliseSession({ ...row.session, messages: [] })
        if (!session) throw new Error('Invalid stored session metadata.')
        const { messages: _messages, ...meta } = session
        this.metadata.set(session.id, { session: meta, messageCount: row.messageCount })
      }
      let files: string[]
      try { files = await readdir(sessionsDir()) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        files = []
      }
      for (const name of files.filter((value) => value.endsWith('.json'))) {
        const fileId = name.slice(0, -5)
        if (db.hasImported(fileId)) continue
        try {
          const raw = JSON.parse(await readFile(join(sessionsDir(), name), 'utf8')) as unknown
          const session = normaliseSession(raw)
          if (!session || safeFileName(session.id) !== fileId) throw new Error('Invalid legacy session identity.')
          if (db.hasImported(session.id)) continue
          if (db.has(session.id)) throw new Error('Legacy session conflicts with database.')
          db.put(session, true)
          const { messages, ...meta } = session
          this.metadata.set(session.id, { session: meta, messageCount: messages.length })
        } catch (error) {
          this.loadWasIncomplete = true
          console.error('[openbot/store] legacy session was not imported; original remains intact:', name, error)
        }
      }
      this.db = db
    } catch (error) { db.close(); throw error }
  }
  /** Full scans are explicit (search/export), never used for navigation. */
  all(): Session[] { return [...this.metadata.keys()].map(id => this.get(id)!) }
  entries(): Array<{ session: Omit<Session, 'messages'>; messageCount: number }> { return [...this.metadata.values()] }
  get(id: string): Session | null {
    const cached = this.cache.get(id)
    if (cached) return cached
    if (!this.metadata.has(id)) return null
    const session = normaliseSession(this.db?.get(id))
    if (!session) throw new Error('Stored session could not be read.')
    this.cache.set(id, session)
    return session
  }
  put(session: Session): Session {
    if (!this.db) throw new Error('Session storage is unavailable.')
    // Normalisation is for disk reload: it labels a saved streaming checkpoint
    // interrupted. Doing that during a live write would terminate its state.
    const saved = this.db.put(session)
    this.cache.set(session.id, saved)
    const { messages, ...meta } = saved
    this.metadata.set(session.id, { session: meta, messageCount: messages.length })
    return saved
  }
  delete(id: string): boolean {
    if (!this.db) throw new Error('Session storage is unavailable.')
    const existed = this.db.delete(id)
    this.cache.delete(id)
    this.metadata.delete(id)
    return existed
  }
  blob(ref: string): string | null { return this.db?.getBlob(ref) ?? null }
  hasMessage(sessionId: string, messageId: string): boolean { return this.db?.hasMessage(sessionId, messageId) ?? false }
}
