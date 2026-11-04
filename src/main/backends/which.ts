/**
 * PATH probing over the hydrated login-shell environment.
 *
 * This is what tells "not installed" apart from "installed but not running".
 * It never spawns anything and never throws.
 */

import { access, constants } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { delimiter, isAbsolute } from 'node:path'
import { firstExecutable, guiBinaryDirs, nvmVersionBinDirs } from './guiPath'
import { installedNvmVersions, readUserNpmrc } from './userBins'
import { hydratedPath } from './loginShellEnv'

const isWindows = platform() === 'win32'

/**
 * Locations a Dock launch does not put on PATH. Cached until an explicit
 * refresh: npmrc and nvm's version list do not change mid-session unless
 * the user asks us to look again.
 */
let fallbackPromise: Promise<string[]> | null = null

async function fallbackDirs(): Promise<string[]> {
  // Screenshot runs must not discover a CLI on the runner and skip the
  // empty-backend chat the job is there to capture.
  if (process.env.BLINKY_SHOTS === '1') return []
  fallbackPromise ??= (async () => {
    const home = homedir()
    const [npmrc, nvmNames] = await Promise.all([readUserNpmrc(home), installedNvmVersions(home)])
    const dirs = guiBinaryDirs({
      home,
      platform: platform(),
      env: process.env,
      ...(npmrc !== undefined ? { npmrc } : {}),
      extraDirs: nvmVersionBinDirs(home, nvmNames)
    })
    if (!isWindows) dirs.push('/Applications/Ollama.app/Contents/Resources')
    return dirs
  })()
  return fallbackPromise
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
  fallbackPromise = null
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

  const dirs = [...(await hydratedPath()).split(delimiter).filter(Boolean), ...(await fallbackDirs())]
  for (const candidate of candidateNames(name)) {
    const found = await firstExecutable(candidate, dirs, isExecutable)
    if (found) return found
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
