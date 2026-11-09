import { supportsFullAccessExecution } from '../../shared/executionAccess'
import type { Settings } from '../../shared/settings'
import type { Bot, Session } from '../../shared/types'

/** Runtime overrides are scoped to the private execution conversation only. */
const running = new Map<string, NonNullable<Bot['executionAgent']>>()
const owners = new Map<string, string>()
const accessSignals = new Map<string, AbortController>()

export function setExecutionAgent(sessionId: string, runtime: NonNullable<Bot['executionAgent']>, botId?: string): void {
  accessSignals.get(sessionId)?.abort()
  accessSignals.set(sessionId, new AbortController())
  running.set(sessionId, { ...runtime })
  if (botId) owners.set(sessionId, botId)
}
export function clearExecutionAgent(sessionId: string): void {
  accessSignals.get(sessionId)?.abort(); accessSignals.delete(sessionId)
  running.delete(sessionId); owners.delete(sessionId)
}
export function fullAccessExecutor(sessionId: string): boolean {
  return supportsFullAccessExecution(running.get(sessionId)?.backendId ?? '') && running.get(sessionId)?.accessMode === 'full-access' && !accessSignals.get(sessionId)?.signal.aborted
}
export function executorAccessSignal(sessionId: string): AbortSignal | undefined { return accessSignals.get(sessionId)?.signal }
/** A saved revocation cancels active work; it never upgrades a pinned old task. */
export function revokeExecutorAccess(botId: string): void {
  for (const [sessionId, owner] of owners) if (owner === botId && running.get(sessionId)?.accessMode === 'full-access') accessSignals.get(sessionId)?.abort()
}
/** Bot semantic review does not govern an explicitly authorized local executor. */
export function executionApprovalSettings(settings: Settings, sessionId: string, local: boolean): Settings {
  if (!local || !fullAccessExecutor(sessionId) || settings.localExecutionPolicy === 'never-allow') return settings
  return { ...settings, localExecutionPolicy: 'always-allow', automaticReview: true, semanticPermissionRules: [] }
}
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
  return { ...bot, backendId: runtime.backendId, modelId: runtime.modelId, thinking: runtime.thinking, followsDefault: false, executionAgent: undefined, systemPrompt: `${bot.systemPrompt}\n\nYou are an independent background execution agent. Complete the delegated task and report the outcome to the lead. Use the application ask_user tool for genuinely missing information; it routes to the owning Bot first. Native permission decisions are separate from clarification. A rejected action remains rejected: never change tool, client, mode or identity to replay it.`, tools }
}
