/**
 * Assignment sync for the settings Tools page.
 *
 * The owners are local CLIs (Codex, Kimi, and the rest), not Bots.
 * Sync copies AGENTS.md assignments and only adds what is missing.
 * Skills live in CLI directories, and MCP servers are shared, so sync never
 * disables an MCP server or rewrites a skill folder.
 */

export interface SkillSource {
  id: string
  name: string
  origin: string
  description: string
  path: string
  shared?: boolean
}

export interface GroupedSkill<T extends SkillSource = SkillSource> {
  name: string
  description: string
  sources: T[]
}

/** One row per skill name. Sources stay attached so the UI can show them as tags. */
export function groupSkills<T extends SkillSource>(skills: readonly T[]): Array<GroupedSkill<T>> {
  const groups = new Map<string, GroupedSkill<T>>()
  for (const skill of skills) {
    const key = skill.name.trim() || skill.id
    const existing = groups.get(key)
    if (!existing) groups.set(key, { name: key, description: skill.description ?? '', sources: [skill] })
    else {
      existing.sources.push(skill)
      if ((skill.description ?? '').length > existing.description.length) existing.description = skill.description
    }
  }
  return [...groups.values()]
}

export interface ToolOwner {
  id: string
  name: string
  agentsMdIds: readonly string[]
}

export interface EntitySyncStep {
  id: string
  addAgentsMd: string[]
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
}

/**
 * Add-only plan. Base copies one local CLI's AGENTS.md onto the others.
 * Merge unions every local CLI's files. Nothing is removed.
 */
export function entitySyncPlan(owners: readonly ToolOwner[], mode: 'base' | 'merge', baselineId?: string): EntitySyncStep[] {
  const usable = owners.filter((owner) => owner.id)
  if (usable.length < 2) return []
  const baseline = mode === 'base' ? usable.find((owner) => owner.id === baselineId) : undefined
  if (mode === 'base' && !baseline) return []
  const desiredFiles = unique(mode === 'merge' ? usable.flatMap((owner) => owner.agentsMdIds) : baseline!.agentsMdIds)
  const plan: EntitySyncStep[] = []
  for (const owner of usable) {
    if (mode === 'base' && owner.id === baselineId) continue
    const haveFiles = new Set(owner.agentsMdIds)
    const addAgentsMd = desiredFiles.filter((id) => !haveFiles.has(id))
    if (addAgentsMd.length) plan.push({ id: owner.id, addAgentsMd })
  }
  return plan
}

/** Sync must not flip a shared MCP server off. */
export function mcpServersAfterSync<T extends { id: string; enabled: boolean }>(servers: readonly T[]): T[] {
  return servers.map((server) => ({ ...server }))
}
