import type { Bot, Session } from '../../shared/types'

/** Runtime overrides are scoped to the private execution conversation only. */
const running = new Map<string, NonNullable<Bot['executionAgent']>>()
const owners = new Map<string, string>()

export function setExecutionAgent(sessionId: string, runtime: NonNullable<Bot['executionAgent']>, botId?: string): void {
  running.set(sessionId, runtime)
  if (botId) owners.set(sessionId, botId)
}
export function clearExecutionAgent(sessionId: string): void { running.delete(sessionId); owners.delete(sessionId) }
export function backgroundBotOwner(sessionId: string): string | undefined { return owners.get(sessionId) }
export function isExecutionAgent(sessionId: string): boolean { return running.has(sessionId) }
const teammateRuns = new Set<string>()
export function setTeammateRun(sessionId: string, botId?: string): void { teammateRuns.add(sessionId); if (botId) owners.set(sessionId, botId) }
export function clearTeammateRun(sessionId: string): void { teammateRuns.delete(sessionId); owners.delete(sessionId) }
export function isTracedBackgroundRun(sessionId: string): boolean { return isExecutionAgent(sessionId) || teammateRuns.has(sessionId) }

/** A Codex lead coordinates independent work; workers keep their own permissions. */
export function isCodexCoordinator(session: Session, bot: Bot): boolean {
  return session.mode === 'agent' && bot.backendId === 'codex' && Boolean(bot.executionAgent) && bot.tools.includes('delegate_task') && !isTracedBackgroundRun(session.id)
}

export function bindExecutionAgent(sessionId: string, bot: Bot): Bot {
  const runtime = running.get(sessionId)
  if (!runtime) return bot
  const tools = bot.tools.includes('delegate_task')
    ? [...new Set([...bot.tools, 'manage_task'])].filter((tool) => tool !== 'delegate_task')
    : bot.tools.filter((tool) => tool !== 'delegate_task')
  return { ...bot, backendId: runtime.backendId, modelId: runtime.modelId, thinking: runtime.thinking, followsDefault: false, executionAgent: undefined, systemPrompt: `${bot.systemPrompt}\n\nYou are an independent background execution agent. Complete the delegated task and report the outcome to the lead.`, tools }
}
