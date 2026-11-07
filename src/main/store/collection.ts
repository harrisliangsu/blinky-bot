/**
 * A directory of `<id>.json` documents with an in-memory cache.
 *
 * The directory is resolved lazily so instances can be created at module scope,
 * before Electron's `app` is ready. Everything is read once at startup; the
 * cache is authoritative afterwards, which lets the CRUD modules expose plain
 * synchronous accessors.
 */

import { join } from 'node:path'
import { deleteJson, readJsonDirState, writeJsonDebounced } from './jsonStore'
// Straight from the reader: `jsonStore` is the barrel for the read/write API,
// and moving a rejected document aside is neither.
import { quarantineDocument } from './jsonRead'
import { safeFileName } from './paths'

export class JsonCollection<T extends { id: string }> {
  private readonly cache = new Map<string, T>()
  /**
   * The in-progress or completed load. Memoising the promise — rather than a
   * boolean set before the first `await` — is what stops a second caller from
   * being handed a half-loaded, or entirely empty, cache.
   */
  private loading: Promise<void> | null = null

  constructor(
    private readonly resolveDir: () => string,
    /** Coerce a parsed document into a valid `T`, or reject it with null. */
    private readonly normalise: (raw: unknown) => T | null
  ) {}

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.readAll().catch((err) => {
        // Do not memoise a failure: the next call gets a fresh attempt rather
        // than an empty cache that looks authoritative for the whole session.
        this.loading = null
        throw err
      })
    }
    return this.loading
  }

  /**
   * True when a document existed but could not be read.
   *
   * The cache is authoritative for everything else, but it is NOT the complete
   * set — so anything that reasons about absence ("this project no longer
   * exists, unfile its chats") must check this first, or one unreadable file
   * becomes permanent data loss.
   */
  private incomplete = false

  get loadWasIncomplete(): boolean {
    return this.incomplete
  }

  private async readAll(): Promise<void> {
    const read = await readJsonDirState<unknown>(this.resolveDir())
    this.incomplete = read.incomplete
    for (const { file, value } of read.documents) {
      const item = this.normalise(value)
      if (item) {
        this.cache.set(item.id, item)
        continue
      }
      /*
       * A document that parsed cleanly and then failed `normalise` — no `id`,
       * or a shape this version cannot read — was dropped without a trace: not
       * in the cache, not in `unreadable`, and the load still called itself
       * complete. For projects that is data loss, not a display glitch:
       * `unfileOrphanedSessions` reads the project's absence as deletion and
       * strips `projectId` from every chat filed under it, then persists that.
       * The board is recoverable from `backups/`; the filing is not.
       *
       * So the load is incomplete — which stops the cascade — and the document
       * is moved aside, which stops the same rejection repeating every launch.
       */
      this.incomplete = true
      console.warn('[openbot/store] a document could not be read as valid ->', file)
      await quarantineDocument(file)
    }
  }

  get size(): number {
    return this.cache.size
  }

  all(): T[] {
    return [...this.cache.values()]
  }

  get(id: string): T | null {
    return this.cache.get(id) ?? null
  }

  has(id: string): boolean {
    return this.cache.has(id)
  }

  /** Upsert; schedules a debounced write. Returns the stored item. */
  put(item: T): T {
    this.adopt(item)
    writeJsonDebounced(this.fileFor(item.id), item)
    return item
  }

  /** Adopt an item already covered by a separate durable transaction/journal. */
  adopt(item: T): T {
    this.cache.set(item.id, item)
    return item
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id)
    void deleteJson(this.fileFor(id))
    return existed
  }

  private fileFor(id: string): string {
    return join(this.resolveDir(), `${safeFileName(id)}.json`)
  }
}
