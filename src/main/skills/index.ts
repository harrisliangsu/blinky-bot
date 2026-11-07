/**
 * The skills engine's public surface.
 *
 * Skills change rarely and a scan touches the filesystem, so results are cached
 * per working folder and invalidated explicitly — after an install or uninstall,
 * or when a caller asks for a refresh. The UI can therefore render the cached
 * list immediately and refresh in the background.
 *
 * Everything here is safe to call at any time: discovery never throws, and
 * install/uninstall report failure as a result rather than an exception.
 */

import { isAbsolute, join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import {
  parseSkillId,
  type Skill,
  type SkillInstallOptions,
  type SkillInstallResult,
  type SkillBulkSyncResult,
  type SkillUninstallResult
} from '../../shared/skills'
import { discoverSkills, scanRoot, viewFor } from './discover'
import { installSkill as writeSkill, uninstallSkill as deleteSkill } from './install'
import { skillsPromptSection } from './prompt'
import { sharedSkillsDir } from './roots'
import { localAgentSkillTargets, removeSkillLinks, syncSkillLinks } from './sync'
import { verifySkillBatch, verifySkillRuntime, type SkillVerificationReport } from './runtime'

export interface SkillsQuery {
  /** Session working folder, to include its project-local skills. */
  cwd?: string
  /** Skip the cache and re-scan disk. */
  refresh?: boolean
}

const cache = new Map<string, Skill[]>()
const inFlight = new Map<string, Promise<Skill[]>>()
/** Bumped by every invalidation, so a scan that raced one cannot cache its stale answer. */
let generation = 0
/** One entry per working folder ever opened; oldest goes first. */
const MAX_CACHED_ROOTS = 24

/**
 * A cwd only contributes project roots when it is absolute, so anything else is
 * the same scan as no cwd at all and shares its entry. `resolve` folds the
 * spellings of one folder (`/a/b`, `/a/b/`, `/a/./b`) onto one key.
 */
function keyOf(cwd?: string): string {
  return typeof cwd === 'string' && isAbsolute(cwd) ? resolve(cwd) : ''
}

function remember(key: string, skills: Skill[]): void {
  cache.set(key, skills)
  while (cache.size > MAX_CACHED_ROOTS) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Every skill on this machine. Cached; pass `refresh` to re-scan. */
export async function listSkills(query: SkillsQuery = {}): Promise<Skill[]> {
  const key = keyOf(query.cwd)
  if (!query.refresh) {
    const hit = cache.get(key)
    if (hit) return hit
    const running = inFlight.get(key)
    if (running) return running
  }

  const startedAt = generation
  const scan: Promise<Skill[]> = discoverSkills({ cwd: key || undefined })
    .then((skills) => {
      // An install or uninstall landed while this was running: the answer is
      // already out of date, so hand it back but never seed the cache with it.
      if (generation === startedAt) remember(key, skills)
      return skills
    })
    .catch(() => cache.get(key) ?? [])
    .finally(() => {
      if (inFlight.get(key) === scan) inFlight.delete(key)
    })

  inFlight.set(key, scan)
  return scan
}

/** The cached list without touching disk, or `null` if nothing is cached yet. */
export function cachedSkills(query: SkillsQuery = {}): Skill[] | null {
  return cache.get(keyOf(query.cwd)) ?? null
}

/**
 * The skills a given backend can actually see, name collisions resolved by that
 * CLI's preference chain. Agent CLIs load these themselves; for backends running
 * OpenBOT's own loop the list is what the prompt section advertises.
 */
export async function skillsFor(backendId: string, query: SkillsQuery = {}): Promise<Skill[]> {
  return viewFor(await listSkills(query), backendId)
}

/**
 * Resolve assigned skill ids to skills, in the order they were assigned.
 * Ids that no longer exist on disk are dropped silently — a skill the user
 * removed should not break a bot.
 */
export async function resolveSkills(ids: string[], query: SkillsQuery = {}): Promise<Skill[]> {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const all = await listSkills(query)
  const byId = new Map(all.map((skill) => [skill.id, skill]))

  const out: Skill[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    const skill = byId.get(id)
    if (skill) out.push(skill)
  }
  return out
}

/** True when the id is well formed, whether or not it is installed. */
export function isSkillId(id: string): boolean {
  return parseSkillId(id) !== null
}

/**
 * The system-prompt section for a bot's assigned skills, or `''` when it has
 * none. Feed this to `composeSystemPrompt` via `extras`.
 */
export async function skillsSectionFor(ids: string[], query: SkillsQuery = {}): Promise<string> {
  return skillsPromptSection(await resolveSkills(ids, query))
}

/** Install a picked folder and report links into local Agent directories. */
export async function installSkill(
  sourcePath: string,
  opts: SkillInstallOptions = {}
): Promise<SkillInstallResult & Partial<SkillVerificationReport>> {
  const result: SkillInstallResult & Partial<SkillVerificationReport> = await writeSkill(sourcePath, opts)
  if (result.ok && result.skill) {
    try {
      const targets = await localAgentSkillTargets()
      result.sync = await syncSkillLinks(sharedSkillsDir(), result.skill.name, targets)
      result.verification = await verifySkillRuntime(result.skill.name, result.skill.path, targets, 'present')
    }
    catch (error) { result.sync = [{ agent: 'Local agents', path: sharedSkillsDir(), status: 'error', detail: error instanceof Error ? error.message : 'Skill synchronization failed.' }] }
    invalidateSkills()
  }
  return result
}

/** Remove a skill OpenBOT installed. Never touches a CLI's own directory. */
export async function uninstallSkill(id: string): Promise<SkillUninstallResult & Partial<SkillVerificationReport>> {
  const parsed = parseSkillId(id)
  const targets = parsed?.origin === 'agents' ? await localAgentSkillTargets() : []
  if (parsed?.origin === 'agents') {
    try { await removeSkillLinks(sharedSkillsDir(), parsed.name, targets) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not remove the skill links safely.' } }
  }
  const result: SkillUninstallResult & Partial<SkillVerificationReport> = await deleteSkill(id)
  if (result.ok) {
    invalidateSkills()
    if (parsed) result.verification = await verifySkillRuntime(parsed.name, join(sharedSkillsDir(), parsed.name), targets, 'removed')
  }
  return result
}

/** Explicitly synchronize skills that were already in the shared directory. */
export async function syncExistingSkills(): Promise<SkillBulkSyncResult & Partial<SkillVerificationReport>> {
  const shared = sharedSkillsDir()
  try { await readdir(shared) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, skills: 0, linked: 0, unavailable: 0, issues: [] }
    return { ok: false, skills: 0, linked: 0, unavailable: 0, issues: [], error: 'Cannot read the shared skills directory.' }
  }
  const skills = await scanRoot({ origin: 'agents', dir: shared, shared: true })
  const targets = await localAgentSkillTargets()
  const report: SkillBulkSyncResult & Partial<SkillVerificationReport> = { ok: true, skills: skills.length, linked: 0, unavailable: 0, issues: [] }
  for (const skill of skills) {
    if (resolve(skill.path) !== join(shared, skill.name)) {
      report.issues.push({ skill: skill.name, agent: 'Shared directory', detail: 'Folder name differs from skill name.' })
      continue
    }
    try {
      const results = await syncSkillLinks(shared, skill.name, targets)
      for (const result of results) {
        if (result.status === 'linked' || result.status === 'existing') report.linked++
        else if (result.status === 'unavailable') report.unavailable++
        else report.issues.push({ skill: skill.name, agent: result.agent, detail: result.detail ?? result.status })
      }
    } catch (error) { report.issues.push({ skill: skill.name, agent: 'Local agents', detail: error instanceof Error ? error.message : 'Sync failed.' }) }
  }
  invalidateSkills()
  report.verification = await verifySkillBatch(skills.map((skill) => ({ name: skill.name, dir: skill.path })), targets)
  return report
}

/** Drop every cached scan; the next read hits disk. */
export function invalidateSkills(): void {
  generation++
  cache.clear()
  inFlight.clear()
}

export { sharedSkillsDir, skillsPromptSection }
export type { Skill, SkillInstallOptions, SkillInstallResult, SkillUninstallResult }
