/**
 * Writing JSON documents: atomic, debounced, and loud when it fails.
 *
 *   · atomic   — serialise to a temp file, fsync it, `rename()` over the target,
 *                then fsync the directory the rename landed in
 *   · debounced — coalesce bursts of writes (~200ms, hard ceiling 1s)
 *   · reported — a failed write is remembered, so the flush on quit can say so
 *                instead of resolving as though everything was saved
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir } from './paths'

const DEBOUNCE_MS = 200
/**
 * Every store document is created owner-only.
 *
 * `open(tmp, 'w')` takes the default 0666, so files landed at 0644 after the
 * umask — including `backend-secrets.json` and `vm-secrets.json`, which hold
 * encrypted API keys and were therefore readable by every other account on the
 * machine. Setting it on the one `open()` that creates the file covers every
 * writer without each of them having to remember, and costs nothing: these are
 * all per-user application data, so nothing wants the group or world bits. The
 * rename carries the mode onto the target, so documents written by an earlier
 * version are tightened the next time they are saved.
 */
const FILE_MODE = 0o600
/** Never let a queued write starve for longer than this under a write storm. */
const MAX_WAIT_MS = 1000
/** Drain passes `flushAll` will make before giving up on a runaway writer. */
const MAX_FLUSH_ROUNDS = 20

interface PendingWrite {
  data: unknown
  timer: ReturnType<typeof setTimeout>
  queuedAt: number
}

const pending = new Map<string, PendingWrite>()
const inFlight = new Map<string, Promise<void>>()
/** Files whose most recent write or delete failed, with the reason. */
const failures = new Map<string, string>()
/** Documents deleted this session; a later write must not resurrect them. */
const tombstones = new Set<string>()

function recordFailure(file: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err)
  failures.set(file, reason)
  console.error('[openbot/store] write failed', file, err)
  return new Error(`could not write ${file}: ${reason}`, { cause: err })
}

/**
 * fsync the directory the rename landed in.
 *
 * The temp file's bytes are synced before the rename, but the rename itself is
 * a change to the *parent directory*. Without this, a power loss can lose that
 * directory entry and the file reverts — intact but stale — to the version
 * before the write, which is the one outcome the temp-and-rename dance exists
 * to rule out.
 */
async function syncParentDir(file: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dirname(file), 'r')
    await handle.sync()
  } catch (err) {
    // Windows cannot open a directory handle, and some network volumes refuse
    // the fsync. The bytes are already durable either way, so this is never
    // allowed to turn a successful write into a reported failure.
    if (process.platform !== 'win32') console.warn('[openbot/store] dir sync failed', file, err)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Throws on failure, having recorded it. */
async function writeAtomic(file: string, data: unknown): Promise<void> {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  let text: string
  try {
    text = JSON.stringify(data, null, 2)
  } catch (err) {
    throw recordFailure(file, err)
  }
  try {
    const handle = await fs.open(tmp, 'w', FILE_MODE)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw recordFailure(file, err)
  }
  await syncParentDir(file)
  failures.delete(file)
}

/**
 * Chain operations per file so two flushes can never interleave.
 *
 * The link the *next* operation waits on can never reject — one failed write
 * must not poison everything queued behind it — but the promise handed back to
 * the caller does. That split is the whole point: `await writeJsonNow(...)` into
 * an unwritable directory used to resolve normally.
 */
function enqueue(file: string, run: () => Promise<void>): Promise<void> {
  const previous = inFlight.get(file) ?? Promise.resolve()
  const result = previous.then(run)
  const link = result.catch(() => undefined)
  inFlight.set(file, link)
  void link.then(() => {
    if (inFlight.get(file) === link) inFlight.delete(file)
  })
  return result
}

function cancelPending(file: string): void {
  const existing = pending.get(file)
  if (!existing) return
  clearTimeout(existing.timer)
  pending.delete(file)
}

function isDeleted(file: string): boolean {
  if (!tombstones.has(file)) return false
  console.warn('[openbot/store] refusing to write a deleted document', file)
  return true
}

/** Queue a debounced write. The most recent value wins. */
export function writeJsonDebounced(file: string, data: unknown): void {
  if (isDeleted(file)) return
  const existing = pending.get(file)
  const queuedAt = existing?.queuedAt ?? Date.now()
  if (existing) clearTimeout(existing.timer)
  const waited = Date.now() - queuedAt
  const delay = waited >= MAX_WAIT_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited)
  const timer = setTimeout(() => void flushFile(file), delay)
  timer.unref?.()
  pending.set(file, { data, timer, queuedAt })
}

/** Write immediately, bypassing the debounce. Rejects if the write failed. */
export async function writeJsonNow(file: string, data: unknown): Promise<void> {
  cancelPending(file)
  if (isDeleted(file)) return
  await enqueue(file, () => writeAtomic(file, data))
}

async function flushFile(file: string): Promise<void> {
  const entry = pending.get(file)
  if (!entry) return
  cancelPending(file)
  // Swallowed deliberately: this runs from a debounce timer with nobody to catch
  // it, and an unhandled rejection there would take the process down. The
  // failure is already recorded, and `flushAll` reports it.
  await enqueue(file, () => writeAtomic(file, entry.data)).catch(() => undefined)
}

/**
 * Drop any queued write, delete the file, and remember that it is gone.
 *
 * The tombstone is the guard: a debounced write issued *after* the delete —
 * `removeSession(id)` followed by a save of a stale object still held by a
 * running turn — used to recreate the file, and the chat came back from the
 * dead on the next launch.
 */
export async function deleteJson(file: string): Promise<void> {
  cancelPending(file)
  tombstones.add(file)
  await enqueue(file, async () => {
    try {
      await fs.rm(file, { force: true })
      await syncParentDir(file)
      failures.delete(file)
    } catch (err) {
      recordFailure(file, err)
    }
  })
}

/**
 * Lift the tombstone, for a caller deliberately recreating a document it
 * deleted earlier in this session. Nothing else may: a write to a deleted path
 * is the stale-value race the tombstone exists to catch.
 */
export function reviveJson(file: string): void {
  tombstones.delete(file)
}

export interface FlushReport {
  /** Files whose most recent write or delete failed. Empty means all landed. */
  failed: string[]
  /** True when writes were still arriving after the drain gave up. */
  stillWriting: boolean
}

function report(stillWriting: boolean): FlushReport {
  return { failed: [...failures.keys()], stillWriting }
}

/**
 * Flush every pending write, wait for all in-flight writes, report the damage.
 *
 * Draining takes more than one pass on purpose: the renderer and the agent loop
 * are still live while `before-quit` awaits this, so a mutation can be queued
 * during a pass. A single pass would leave that last write on the floor — the
 * message someone typed as they hit Cmd-Q.
 *
 * The report is not decoration. This resolved silently while every write failed,
 * so the app closed looking like it had saved.
 */
export async function flushAll(): Promise<FlushReport> {
  for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
    if (pending.size === 0 && inFlight.size === 0) return report(false)
    await Promise.all([...pending.keys()].map((file) => flushFile(file)))
    await Promise.all([...inFlight.values()])
  }
  console.warn('[openbot/store] writes still arriving after', MAX_FLUSH_ROUNDS, 'flush rounds')
  return report(true)
}
