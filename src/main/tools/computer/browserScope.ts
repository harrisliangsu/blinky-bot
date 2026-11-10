/** Persistent browser ownership policy. Existing bot-only profiles remain legacy. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultUserDataDir, profileLayout } from './browser/profile'

export type BrowserScopeMode = 'legacy' | 'session'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

function policyPath(botId: string, dataDir?: string): string {
  return join(dataDir ?? defaultUserDataDir(), 'computers', `.scope-v1-${hash(botId)}.json`)
}

function readPolicy(path: string, botId: string): BrowserScopeMode {
  const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; botId?: string; mode?: string }
  if (value.version !== 1 || value.botId !== botId || (value.mode !== 'legacy' && value.mode !== 'session')) throw new Error('The browser ownership record is invalid; no browser was opened.')
  return value.mode
}

/** Read status without opening a browser or creating a record. */
export function peekBrowserScopeMode(botId: string, dataDir?: string): BrowserScopeMode {
  if (!botId.trim()) throw new Error('A browser needs a Bot owner.')
  const path = policyPath(botId, dataDir)
  if (existsSync(path)) return readPolicy(path, botId)
  return existsSync(profileLayout(botId, dataDir).root) ? 'legacy' : 'session'
}

/** Publish exactly one choice before any provider may create the old root. */
export function browserScopeMode(botId: string, dataDir?: string): BrowserScopeMode {
  if (!botId.trim()) throw new Error('A browser needs a Bot owner.')
  profileLayout(botId, dataDir) // Validate before creating even the policy parent.
  const path = policyPath(botId, dataDir)
  if (existsSync(path)) return readPolicy(path, botId)
  mkdirSync(join(dataDir ?? defaultUserDataDir(), 'computers'), { recursive: true })
  const mode = peekBrowserScopeMode(botId, dataDir)
  const temp = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ version: 1, botId, mode }))
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    try { linkSync(temp, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return readPolicy(path, botId)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* no published record is removed */ }
  }
}

export function browserScopeId(botId: string, sessionId: string | undefined, dataDir?: string): { id: string; mode: BrowserScopeMode } {
  // A rejected request must not publish a lasting choice for a Bot. In
  // particular, callers of the old API may not yet have a session id.
  if (!sessionId?.trim() && peekBrowserScopeMode(botId, dataDir) !== 'legacy') throw new Error('This browser requires its conversation id.')
  const mode = browserScopeMode(botId, dataDir)
  if (mode === 'legacy') return { id: botId, mode }
  if (!sessionId?.trim()) throw new Error('This browser requires its conversation id.')
  return { id: `session-v1-${hash(JSON.stringify([botId, sessionId]))}`, mode }
}
