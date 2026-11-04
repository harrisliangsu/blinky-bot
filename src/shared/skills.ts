/**
 * Skills: folder playbooks (`SKILL.md` plus supporting files) that the agent
 * CLIs already load natively from well-known directories.
 *
 * OpenBOT never executes a skill. It discovers what is installed, lets the user
 * assign skills per bot, and installs new ones into the one directory every CLI
 * reads (`~/.agents/skills`) so a skill is installed once rather than per CLI.
 *
 * A bot's assigned skills are ids (`origin:name`); the ids are resolved back to
 * folders at prompt time, so a skill removed on disk simply drops out.
 */

export type SkillOrigin = 'claude' | 'opencode' | 'codex' | 'kimi' | 'grok' | 'pi' | 'agents' | 'project'

export interface Skill {
  /** Stable: `${origin}:${name}`. */
  id: string
  /** Frontmatter `name`, falling back to the folder name. */
  name: string
  description: string
  origin: SkillOrigin
  /** Absolute folder path. */
  path: string
  /** True when this skill is in the shared dir, so every CLI can see it. */
  shared: boolean
  updatedAt: number
}

export interface SkillInstallOptions {
  /** Replace an already-installed skill of the same name. */
  overwrite?: boolean
}

export interface SkillInstallResult {
  ok: boolean
  skill?: Skill
  error?: string
}

export interface SkillUninstallResult {
  ok: boolean
  error?: string
}

/** The file that makes a folder a skill. */
export const SKILL_FILE = 'SKILL.md'

/** The one directory every CLI reads. Installs go here. */
export const SHARED_SKILL_ORIGIN: SkillOrigin = 'agents'

export const SKILL_ORIGINS: readonly SkillOrigin[] = [
  'agents',
  'claude',
  'opencode',
  'codex',
  'kimi',
  'grok',
  'pi',
  'project'
]

/** Short labels for the UI; the shared one says why it matters. */
export const SKILL_ORIGIN_LABELS: Record<SkillOrigin, string> = {
  agents: 'Shared — every CLI',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  kimi: 'Kimi Code',
  grok: 'Grok',
  pi: 'pi',
  project: 'This project'
}

/**
 * Which origins a given CLI can actually see, best first. A CLI reads its own
 * directory and the shared one; opencode additionally reads Claude's.
 */
export const SKILL_PREFERENCE: Record<string, readonly SkillOrigin[]> = {
  opencode: ['opencode', 'claude', 'agents'],
  pi: ['pi', 'agents'],
  claude: ['claude', 'agents'],
  codex: ['codex', 'agents'],
  kimi: ['kimi', 'agents'],
  grok: ['grok', 'agents']
}

/**
 * Backends that run OpenBOT's own tool loop (cloud APIs, local servers, droid)
 * have no skills directory of their own: the bot reads `SKILL.md` with its file
 * tools, so every origin is usable and the shared one is preferred.
 */
export const DEFAULT_SKILL_PREFERENCE: readonly SkillOrigin[] = [
  'agents',
  'claude',
  'opencode',
  'codex',
  'kimi',
  'grok',
  'pi'
]

/**
 * The chain for a backend, always an array.
 *
 * Own properties only: a backend id is renderer input, and a plain-object
 * lookup would answer `preferenceFor('toString')` with a function off
 * `Object.prototype`, which then blows up in `dedupeByPreference`.
 */
export function preferenceFor(backendId: string): readonly SkillOrigin[] {
  if (typeof backendId !== 'string' || !Object.hasOwn(SKILL_PREFERENCE, backendId)) {
    return DEFAULT_SKILL_PREFERENCE
  }
  const chain = SKILL_PREFERENCE[backendId]
  return Array.isArray(chain) ? chain : DEFAULT_SKILL_PREFERENCE
}

export function skillId(origin: SkillOrigin, name: string): string {
  return `${origin}:${name}`
}

export function parseSkillId(id: string): { origin: SkillOrigin; name: string } | null {
  const at = typeof id === 'string' ? id.indexOf(':') : -1
  if (at <= 0) return null
  const origin = id.slice(0, at) as SkillOrigin
  const name = id.slice(at + 1)
  if (!SKILL_ORIGINS.includes(origin) || !isSkillName(name)) return null
  return { origin, name }
}

/**
 * A skill name doubles as a directory name, so it stays to a conservative set:
 * no separators, no leading dot, nothing that could climb out of a parent.
 */
export function isSkillName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..')
}

/**
 * Resolve name collisions the way the CLIs do: keep the copy from the earliest
 * origin in the chain and drop the rest. A project-local skill always wins —
 * the CLI reads the working folder first — unless the chain names `project`
 * itself, in which case that position is honoured.
 */
export function dedupeByPreference(skills: Skill[], chain: readonly SkillOrigin[]): Skill[] {
  if (!Array.isArray(skills)) return []
  const order: readonly SkillOrigin[] = Array.isArray(chain) ? chain : DEFAULT_SKILL_PREFERENCE
  const rank = (origin: SkillOrigin): number => {
    const index = order.indexOf(origin)
    if (index >= 0) return index + 1
    return origin === 'project' ? 0 : Number.POSITIVE_INFINITY
  }

  const ordered = skills
    .map((skill, index) => ({ skill, index, rank: rank(skill.origin) }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)

  const seen = new Set<string>()
  const out: Skill[] = []
  for (const entry of ordered) {
    if (seen.has(entry.skill.name)) continue
    seen.add(entry.skill.name)
    out.push(entry.skill)
  }
  return out
}
