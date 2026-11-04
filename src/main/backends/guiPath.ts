/**
 * Directories a Dock-launched app must search because its PATH is the
 * launchd default, not the user's login shell.
 *
 * Homebrew, `~/.local/bin`, and npm's global prefix are the usual homes of
 * `codex`, `claude`, and `opencode`. The login shell is still asked first
 * (`loginShellEnv`); these directories cover the case where that shell
 * cannot be started.
 */

import { join } from 'node:path'

export interface GuiPathFacts {
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** `~/.npmrc` text, when the file exists. */
  npmrc?: string
  /** Extra directories already resolved, such as every nvm version's `bin`. */
  extraDirs?: readonly string[]
}

/** `prefix=` from `~/.npmrc`, ignoring comments and surrounding quotes. */
export function npmPrefixFromRc(npmrc: string): string | null {
  for (const line of npmrc.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^prefix\s*=\s*(.+)$/.exec(trimmed)
    if (!match) continue
    const value = match[1].trim().replace(/^["']|["']$/g, '')
    return value || null
  }
  return null
}

/**
 * npm's global bin directory.
 *
 * The environment wins over `~/.npmrc` because that is the override npm
 * itself applies (`npm_config_prefix`). A leading `~` is the user's home.
 */
export function npmGlobalBin(facts: Pick<GuiPathFacts, 'home' | 'platform' | 'env' | 'npmrc'>): string | null {
  const fromEnv = facts.env.npm_config_prefix || facts.env.NPM_CONFIG_PREFIX
  const raw = (fromEnv?.trim() || (facts.npmrc ? npmPrefixFromRc(facts.npmrc) : null) || '').trim()
  if (!raw) return null
  const prefix = raw === '~' ? facts.home : raw.startsWith('~/') ? join(facts.home, raw.slice(2)) : raw
  return facts.platform === 'win32' ? prefix : join(prefix, 'bin')
}

/** `~/.nvm/versions/node/<version>/bin` for each installed Node. */
export function nvmVersionBinDirs(home: string, versionNames: readonly string[]): string[] {
  return versionNames
    .filter((name) => /^v\d+\.\d+\.\d+/.test(name))
    .map((name) => join(home, '.nvm', 'versions', 'node', name, 'bin'))
}

/** Directories to search after PATH. Order is preference, not exclusivity. */
export function guiBinaryDirs(facts: GuiPathFacts): string[] {
  const { home, platform } = facts
  const dirs: string[] =
    platform === 'win32'
      ? [
          facts.env.LOCALAPPDATA ? join(facts.env.LOCALAPPDATA, 'Programs') : '',
          facts.env.LOCALAPPDATA ? join(facts.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
          facts.env.APPDATA ? join(facts.env.APPDATA, 'npm') : ''
        ]
      : [
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
          join(home, 'Library', 'pnpm'),
          join(home, '.claude', 'local'),
          join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
          join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin')
        ]
  const npmBin = npmGlobalBin(facts)
  if (npmBin) dirs.push(npmBin)
  if (facts.extraDirs) dirs.push(...facts.extraDirs)
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * First `dir/name` that `isExecutable` accepts.
 *
 * Absolute paths are the caller's problem: this only completes a bare name,
 * which is what `spawn opencode ENOENT` was trying and failing to do.
 */
export async function firstExecutable(
  name: string,
  dirs: readonly string[],
  isExecutable: (fullPath: string) => Promise<boolean>
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const full = join(dir, trimmed)
    if (await isExecutable(full)) return full
  }
  return null
}
