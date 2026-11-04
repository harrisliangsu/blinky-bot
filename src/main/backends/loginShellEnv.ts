/**
 * Login-shell PATH hydration.
 *
 * An Electron app launched from Finder/Dock inherits a stunted environment:
 * binaries installed by homebrew, nvm/fnm, bun, pnpm or pipx are simply not on
 * PATH, so detection silently fails for most users — and it never reproduces
 * when the app is started from a terminal. Recover the real environment by
 * asking the user's login shell for it, then cache the answer.
 *
 * Version managers need no special-casing: an interactive login shell sources
 * them itself.
 */

import { execFile } from 'node:child_process'
import { platform, userInfo } from 'node:os'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'
import { readShellEnvCache, shellFingerprint, writeShellEnvCache } from './shellEnvCache'

const run = promisify(execFile)

const MARKER = '__openbot_env__'
const SHELL_TIMEOUT_MS = 5000

/** Variables worth carrying into probes and child agents. */
const CAPTURE = new Set([
  'PATH',
  'SSH_AUTH_SOCK',
  'HOMEBREW_PREFIX',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'LANG',
  'LC_ALL',
  'NVM_DIR',
  'PNPM_HOME',
  'BUN_INSTALL',
  'PYENV_ROOT',
  'CARGO_HOME',
  'GOPATH'
])

/** `process.env.SHELL` → the account's shell → a platform default. */
export function loginShell(): string {
  const fromEnv = process.env.SHELL
  if (fromEnv) return fromEnv
  try {
    const info = userInfo()
    if (info.shell) return info.shell
  } catch {
    // Some sandboxes cannot read the password database.
  }
  return platform() === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function parseEnvOutput(stdout: string): Record<string, string> | null {
  const at = stdout.lastIndexOf(MARKER)
  const body = at === -1 ? stdout : stdout.slice(at + MARKER.length)
  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m && CAPTURE.has(m[1])) out[m[1]] = m[2]
  }
  return out.PATH ? out : null
}

/** Ask the login shell for its environment; tolerant of rc files that fail. */
async function captureFromShell(shell: string): Promise<Record<string, string> | null> {
  // `env` keeps this portable across zsh/bash/fish without quoting games.
  const command = `printf '\\n%s\\n' '${MARKER}'; env`
  const attempts = [['-ilc', command], ['-lc', command], ['-c', command]]
  for (const args of attempts) {
    try {
      const { stdout } = await run(shell, args, {
        encoding: 'utf8',
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      })
      const parsed = parseEnvOutput(stdout)
      if (parsed) return parsed
    } catch (err) {
      // A non-zero exit still often carries usable output on stdout.
      const stdout = (err as { stdout?: unknown }).stdout
      if (typeof stdout === 'string') {
        const parsed = parseEnvOutput(stdout)
        if (parsed) return parsed
      }
    }
  }
  return null
}

/** macOS last resort when the shell refuses to cooperate. */
async function launchctlPath(): Promise<Record<string, string> | null> {
  if (platform() !== 'darwin') return null
  try {
    const { stdout } = await run('/bin/launchctl', ['getenv', 'PATH'], {
      encoding: 'utf8',
      timeout: 2000
    })
    const value = stdout.trim()
    return value ? { PATH: value } : null
  } catch {
    return null
  }
}

export function mergePaths(...paths: Array<string | undefined>): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const p of paths) {
    if (!p) continue
    for (const dir of p.split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      parts.push(dir)
    }
  }
  return parts.join(delimiter)
}

let pending: Promise<NodeJS.ProcessEnv> | undefined

async function hydrate(): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  if (process.env.BLINKY_SHOTS === '1') {
    base.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    return base
  }
  if (platform() === 'win32') return base

  const shell = loginShell()
  const fingerprint = await shellFingerprint(shell)
  let captured = await readShellEnvCache(fingerprint)

  if (!captured) {
    captured = (await captureFromShell(shell)) ?? (await launchctlPath())
    if (captured) await writeShellEnvCache(fingerprint, captured)
  }
  if (!captured) return base

  for (const [key, value] of Object.entries(captured)) {
    if (value) base[key] = value
  }
  // Union rather than replace: never lose a directory the app already had.
  base.PATH = mergePaths(captured.PATH, process.env.PATH)
  return base
}

/**
 * The environment to use for every probe and every spawned child.
 * Hydration happens at most once per process (plus the disk cache across runs).
 */
export async function hydratedEnv(): Promise<NodeJS.ProcessEnv> {
  pending ??= hydrate().catch(() => ({ ...process.env }))
  return pending
}

export async function hydratedPath(): Promise<string> {
  const env = await hydratedEnv()
  return env.PATH ?? ''
}

/** Drop the in-memory memo so the next call re-reads the cache (or re-hydrates). */
export function resetHydratedEnv(): void {
  pending = undefined
}
