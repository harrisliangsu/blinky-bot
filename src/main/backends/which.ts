/**
 * PATH probing over the hydrated login-shell environment.
 *
 * This is what tells "not installed" apart from "installed but not running".
 * It never spawns anything and never throws.
 */

import { access, constants } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { hydratedPath } from './loginShellEnv'

const isWindows = platform() === 'win32'

/** Locations GUI installers use that even a login shell may not export. */
function fallbackDirs(): string[] {
  const home = homedir()
  if (isWindows) {
    const local = process.env.LOCALAPPDATA
    return local ? [join(local, 'Programs'), join(local, 'Microsoft', 'WindowsApps')] : []
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.kimi', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.claude', 'local'),
    '/Applications/Ollama.app/Contents/Resources'
  ]
}

function candidateNames(bin: string): string[] {
  if (!isWindows) return [bin]
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return /\.[a-z0-9]+$/i.test(bin) ? [bin] : [bin, ...exts.map((e) => bin + e.toLowerCase())]
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, isWindows ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

interface CacheEntry {
  at: number
  path: string | null
}

const cache = new Map<string, CacheEntry>()
const TTL_MS = 30_000

/** Forget cached lookups — called on an explicit backend refresh. */
export function clearWhichCache(): void {
  cache.clear()
}

/** Resolve a binary name (or path) to a full path, or null. */
export async function which(bin: string): Promise<string | null> {
  const name = bin.trim()
  if (!name) return null

  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.path

  const resolved = await resolve(name)
  cache.set(name, { at: Date.now(), path: resolved })
  return resolved
}

async function resolve(name: string): Promise<string | null> {
  if (isAbsolute(name) || name.includes('/') || (isWindows && name.includes('\\'))) {
    for (const candidate of candidateNames(name)) {
      if (await isExecutable(candidate)) return candidate
    }
    return null
  }

  const dirs = [...(await hydratedPath()).split(delimiter).filter(Boolean), ...fallbackDirs()]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const candidate of candidateNames(name)) {
      const full = join(dir, candidate)
      if (await isExecutable(full)) return full
    }
  }
  return null
}

/** True if any of the given paths exists (app bundles, data directories). */
export async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      await access(p, constants.F_OK)
      return true
    } catch {
      // Keep looking.
    }
  }
  return false
}
