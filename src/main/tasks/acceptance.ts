/** Narrow, read-only checks for explicit local output requirements. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentTaskAcceptance } from '../../shared/types'

function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Input paths may be absolute, but checks never reach outside the source workspace. */
export function parseAcceptance(root: string, raw: unknown): AgentTaskAcceptance {
  if (!isAbsolute(root) || !Array.isArray(raw) || !raw.length || raw.length > 10) throw new TypeError('Provide one to ten output files within the current workspace.')
  const base = resolve(root)
  const files = raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Each output check must name a file.')
    const item = value as Record<string, unknown>
    if (Object.keys(item).some((key) => key !== 'path' && key !== 'sha256') || typeof item.path !== 'string' || !item.path.trim() || item.path.length > 4096 || item.path.includes('\0')) throw new TypeError('Invalid output file check.')
    const target = resolve(base, item.path)
    if (!contained(base, target)) throw new TypeError('Output checks must stay within the current workspace.')
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))) throw new TypeError('Expected SHA-256 must contain 64 hexadecimal characters.')
    return { path: relative(base, target), ...(typeof item.sha256 === 'string' ? { sha256: item.sha256.toLowerCase() } : {}) }
  })
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new TypeError('Each output file can only be checked once.')
  return { root: base, files }
}

export function parseSavedAcceptance(raw: unknown): AgentTaskAcceptance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.root !== 'string' || Object.keys(value).some((key) => key !== 'root' && key !== 'files')) return null
  try { return parseAcceptance(value.root, value.files) } catch { return null }
}

async function sha256(file: FileHandle, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Returns only names/hashes, never file contents. A pass is not a full task review. */
export async function verifyAcceptance(acceptance: AgentTaskAcceptance, signal?: AbortSignal): Promise<Array<{ path: string; sha256?: string }>> {
  const parsed = parseSavedAcceptance(acceptance)
  if (!parsed) throw new Error('The saved output checks are invalid; completion cannot be confirmed.')
  let root: string
  try { root = await realpath(parsed.root) } catch { throw new Error('The task workspace is unavailable; output files could not be verified.') }
  const verified: Array<{ path: string; sha256?: string }> = []
  for (const file of parsed.files) {
    if (signal?.aborted) throw new Error('The output check was stopped.')
    let target: string
    try { target = await realpath(resolve(root, file.path)) } catch { throw new Error(`Required output file is missing or inaccessible: ${file.path}`) }
    if (!contained(root, target)) throw new Error(`Output file resolves outside the task workspace: ${file.path}`)
    let observedHash: string
    try {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await handle.stat()
        if (!before.isFile()) throw new Error('not a regular file')
        observedHash = await sha256(handle, signal)
        if (file.sha256 && observedHash !== file.sha256) throw new Error('SHA-256 mismatch')
        const after = await handle.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('file changed during verification')
      } finally { await handle.close() }
    } catch { throw new Error(`Required output file could not be verified: ${file.path}`) }
    verified.push({ path: file.path, sha256: observedHash })
  }
  return verified
}
