/**
 * Assignment sync for the settings Tools page.
 *
 * Built-in tool primitives are not managed here. Sync copies skill assignments
 * and AGENTS.md assignments. It only adds what is missing. MCP servers are
 * shared by every Agent, so sync never disables one.
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

export interface AgentEntities {
  botId: string
  name: string
  skillIds: readonly string[]
  agentsMdIds: readonly string[]
}

export interface EntitySyncStep {
  botId: string
  addSkills: string[]
  addAgentsMd: string[]
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
}

/**
 * Add-only plan. Base copies one Agent's assignments onto the others.
 * Merge unions every Agent's assignments. Nothing is removed.
 */
export function entitySyncPlan(agents: readonly AgentEntities[], mode: 'base' | 'merge', baselineId?: string): EntitySyncStep[] {
  const usable = agents.filter((agent) => agent.botId)
  if (usable.length < 2) return []
  const baseline = mode === 'base' ? usable.find((agent) => agent.botId === baselineId) : undefined
  if (mode === 'base' && !baseline) return []
  const desiredSkills = unique(mode === 'merge' ? usable.flatMap((agent) => agent.skillIds) : baseline!.skillIds)
  const desiredFiles = unique(mode === 'merge' ? usable.flatMap((agent) => agent.agentsMdIds) : baseline!.agentsMdIds)
  const plan: EntitySyncStep[] = []
  for (const agent of usable) {
    if (mode === 'base' && agent.botId === baselineId) continue
    const haveSkills = new Set(agent.skillIds)
    const haveFiles = new Set(agent.agentsMdIds)
    const addSkills = desiredSkills.filter((id) => !haveSkills.has(id))
    const addAgentsMd = desiredFiles.filter((id) => !haveFiles.has(id))
    if (addSkills.length || addAgentsMd.length) plan.push({ botId: agent.botId, addSkills, addAgentsMd })
  }
  return plan
}

/** Sync must not flip a shared MCP server off. */
export function mcpServersAfterSync<T extends { id: string; enabled: boolean }>(servers: readonly T[]): T[] {
  return servers.map((server) => ({ ...server }))
}
