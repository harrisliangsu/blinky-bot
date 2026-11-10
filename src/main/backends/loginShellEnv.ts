/**
 * Login-shell PATH hydration.
 *
 * An Electron app launched from Finder/Dock inherits a stunted environment:
 * binaries installed by homebrew, nvm/fnm, bun, pnpm or pipx are simply not on
 * PATH, so detection silently fails for most users — and it never reproduces
 * when the app is started from a terminal. Recover the real environment by
 * asking the user's login shell for it. Non-sensitive values are cached as a
 * fallback when the shell is unavailable.
 *
 * Version managers need no special-casing: an interactive login shell sources
 * them itself.
 */

import { execFile } from 'node:child_process'
import { homedir, platform, userInfo } from 'node:os'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'
import { readShellEnvCache, shellFingerprint, writeShellEnvCache } from './shellEnvCache'

const run = promisify(execFile)

const MARKER = '__openbot_env__'
const SHELL_TIMEOUT_MS = 5000

const PROXY_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]

/**
 * Variables worth carrying into probes and child agents.
 *
 * HOME and the XDG roots are included so a CLI sees the same credential
 * directory it used when the user signed in from Terminal. CLI home overrides
 * are the documented way those tools relocate that directory.
 */
const CAPTURE = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'HOMEBREW_PREFIX',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'LANG',
  'LC_ALL',
  'NVM_DIR',
  'PNPM_HOME',
  'BUN_INSTALL',
  'PYENV_ROOT',
  'CARGO_HOME',
  'GOPATH',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'KIMI_CODE_HOME',
  'GROK_HOME',
  'PI_CODING_AGENT_DIR',
  ...PROXY_VARS
])

/** Proxy URLs may contain credentials and must not be persisted. */
export function cacheableShellEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_VARS.includes(key)))
}

function safeHome(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

/**
 * Child processes get a copied env, not the login session's defaults.
 * An empty HOME makes every CLI look signed out, because its credential
 * file lives under the real home. The login shell's HOME and XDG roots win
 * when it printed them; otherwise the account home is filled in.
 */
export function withUserIdentity(
  env: NodeJS.ProcessEnv,
  captured?: Record<string, string> | null
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  if (captured) {
    for (const [key, value] of Object.entries(captured)) {
      if (value && CAPTURE.has(key)) next[key] = value
    }
    if (captured.PATH) next.PATH = mergePaths(captured.PATH, env.PATH)
  }
  const home = next.HOME?.trim() || safeHome()
  if (home) next.HOME = home
  try {
    const info = userInfo()
    if (!next.USER?.trim() && info.username) next.USER = info.username
    if (!next.LOGNAME?.trim() && info.username) next.LOGNAME = info.username
    if (!next.SHELL?.trim() && info.shell) next.SHELL = info.shell
  } catch {
    // Some sandboxes cannot read the password database.
  }
  return next
}

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
    return withUserIdentity(base)
  }
  if (platform() === 'win32') return withUserIdentity(base)

  const shell = loginShell()
  const fingerprint = await shellFingerprint(shell)
  const cached = await readShellEnvCache(fingerprint)
  // Proxy settings can change without an rc file changing, and can contain
  // credentials. Always read them afresh and never write them to disk.
  const live = await captureFromShell(shell)
  const captured = live ?? (cached ? cacheableShellEnv(cached) : await launchctlPath())
  if (live) await writeShellEnvCache(fingerprint, cacheableShellEnv(live))
  return withUserIdentity(base, captured)
}

/**
 * The environment to use for every probe and every spawned child.
 * Hydration happens at most once per process; the disk cache is a fallback.
 */
export async function hydratedEnv(): Promise<NodeJS.ProcessEnv> {
  pending ??= hydrate().catch(() => withUserIdentity({ ...process.env }))
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
