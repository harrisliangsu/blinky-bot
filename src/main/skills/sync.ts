/** Create only owned links to the shared copy; never replace another agent's skill. */
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readlink, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { SkillSyncResult } from '../../shared/skills'
import { isSkillName } from '../../shared/skills'
import { hydratedEnv } from '../backends/loginShellEnv'
import { writeJsonNow } from '../store/jsonStore'

export interface SkillSyncTarget { agent: string; dir: string; enabled: boolean }
interface Manifest { version: 1; name: string; target: string; links: string[] }
const locks = new Map<string, Promise<void>>()

async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, current)
  await previous
  try { return await work() } finally { release(); if (locks.get(key) === current) locks.delete(key) }
}

/** A second BlinkyBot process must not replace another process's manifest. */
async function processLock<T>(shared: string, name: string, work: () => Promise<T>): Promise<T> {
  const parent = join(shared, '.blinky-sync')
  const lock = join(parent, `${name}.lock`)
  await mkdir(parent, { recursive: true })
  try { await mkdir(lock) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Skill sync is already running or its previous lock needs inspection: ${lock}`)
    throw error
  }
  try { return await work() } finally { await rmdir(lock).catch(() => undefined) }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function commandAvailable(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try { await access(join(dir, command), constants.X_OK); return true } catch { /* next path */ }
  }
  return false
}

/** Existing skill roots and installed CLIs, including roots not created yet. */
export async function localAgentSkillTargets(): Promise<SkillSyncTarget[]> {
  const home = homedir()
  const env = await hydratedEnv()
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config')
  const candidates = [
    { agent: 'Codex', command: 'codex', dir: join(home, '.codex', 'skills') },
    { agent: 'Claude Code', command: 'claude', dir: join(home, '.claude', 'skills') },
    { agent: 'OpenCode', command: 'opencode', dir: join(config, 'opencode', 'skills') },
    { agent: 'Kimi Code', command: 'kimi', dir: join(home, '.kimi-code', 'skills') },
    { agent: 'Kimi', command: 'kimi', dir: join(home, '.kimi', 'skills') },
    { agent: 'Grok', command: 'grok', dir: join(home, '.grok', 'skills') },
    { agent: 'pi', command: 'pi', dir: join(home, '.pi', 'agent', 'skills') },
    { agent: 'Droid', command: 'droid', dir: join(home, '.factory', 'skills') }
  ]
  for (const [agent, command, variable] of [
    ['Codex (configured)', 'codex', 'CODEX_HOME'],
    ['Claude Code (configured)', 'claude', 'CLAUDE_CONFIG_DIR'],
    ['Kimi Code (configured)', 'kimi', 'KIMI_CODE_HOME'],
    ['Grok (configured)', 'grok', 'GROK_HOME'],
    ['pi (configured)', 'pi', 'PI_CODING_AGENT_DIR']
  ] as const) {
    const base = env[variable]
    if (base && isAbsolute(base)) candidates.push({ agent, command, dir: join(base, 'skills') })
  }
  const unique = candidates.filter((item, index) => candidates.findIndex((other) => resolve(other.dir) === resolve(item.dir)) === index)
  return Promise.all(unique.map(async ({ agent, dir, command }) => ({ agent, dir, enabled: await directoryExists(dir) || await commandAvailable(command, env) })))
}

function manifestPath(shared: string, name: string): string { return join(shared, '.blinky-sync', `${name}.json`) }

async function loadManifest(shared: string, name: string): Promise<Manifest> {
  const file = manifestPath(shared, name)
  let raw: string
  try { raw = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, name, target: join(shared, name), links: [] }
    throw new Error('Cannot read the skill link ownership record.')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('The skill link ownership record is damaged; it was left untouched.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The skill link ownership record is invalid.')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.name !== name || record.target !== join(shared, name) || !Array.isArray(record.links) || !record.links.every((entry) => typeof entry === 'string')) throw new Error('The skill link ownership record is invalid.')
  return record as unknown as Manifest
}

function validate(shared: string, name: string): void {
  if (!isAbsolute(shared) || !isSkillName(name)) throw new Error('Invalid shared skill path or name.')
}

/** Installation is best-effort per host; conflicts and errors are returned. */
export async function syncSkillLinks(shared: string, name: string, targets: SkillSyncTarget[]): Promise<SkillSyncResult[]> {
  validate(shared, name)
  return exclusive(`${shared}:${name}`, () => processLock(shared, name, () => syncUnlocked(shared, name, targets)))
}

async function syncUnlocked(shared: string, name: string, targets: SkillSyncTarget[]): Promise<SkillSyncResult[]> {
  const manifest = await loadManifest(shared, name)
  const results: SkillSyncResult[] = []
  for (const target of targets) {
    const path = join(target.dir, name)
    if (!target.enabled) { results.push({ agent: target.agent, path, status: 'unavailable' }); continue }
    try {
      await mkdir(target.dir, { recursive: true })
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (existing) {
        const same = existing.isSymbolicLink() && resolve(target.dir, await readlink(path)) === manifest.target
        results.push({ agent: target.agent, path, status: same ? 'existing' : 'conflict' })
        continue
      }
      await symlink(manifest.target, path, 'dir')
      manifest.links.push(path)
      try { await writeJsonNow(manifestPath(shared, name), manifest) } catch (error) {
        manifest.links.pop()
        const stillOurs = await readlink(path).then((link) => resolve(target.dir, link) === manifest.target).catch(() => false)
        if (stillOurs) await unlink(path).catch(() => undefined)
        throw error
      }
      results.push({ agent: target.agent, path, status: 'linked' })
    } catch (error) {
      results.push({ agent: target.agent, path, status: 'error', detail: error instanceof Error ? error.message : 'Could not create link.' })
    }
  }
  return results
}

/** Remove only links recorded as ours and still pointing to this shared skill. */
export async function removeSkillLinks(shared: string, name: string, targets: SkillSyncTarget[]): Promise<void> {
  validate(shared, name)
  await exclusive(`${shared}:${name}`, () => processLock(shared, name, () => removeUnlocked(shared, name, targets)))
}

async function removeUnlocked(shared: string, name: string, targets: SkillSyncTarget[]): Promise<void> {
  const manifest = await loadManifest(shared, name)
  const allowed = new Set(targets.map((target) => join(target.dir, name)))
  if (manifest.links.some((path) => !allowed.has(path))) throw new Error('The skill link ownership record contains an unexpected path; no links were removed.')
  for (const path of allowed) {
    if (manifest.links.includes(path)) continue
    const item = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (item?.isSymbolicLink() && resolve(path, '..', await readlink(path)) === manifest.target) throw new Error(`An unmanaged skill link still points to this folder: ${path}. It was left untouched.`)
  }
  for (const path of [...manifest.links]) {
    const item = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (item?.isSymbolicLink() && resolve(path, '..', await readlink(path)) === manifest.target) await unlink(path)
    manifest.links = manifest.links.filter((entry) => entry !== path)
    await writeJsonNow(manifestPath(shared, name), manifest)
  }
  await rm(manifestPath(shared, name), { force: true })
}
