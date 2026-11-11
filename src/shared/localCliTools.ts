/**
 * Tools-page assignment for local CLIs (Codex, Kimi, and the rest of the catalog).
 *
 * Older builds stored AGENTS.md ids on each Bot and labeled those Bots "Agents".
 * A local CLI is the runtime that reads the file. Migration copies a Bot's ids
 * onto every local CLI that Bot actually runs, then the caller clears the Bot field.
 * A Bot whose model is only an API provider keeps its ids; the prompt still reads them.
 */

import { cliById } from './cliCatalog'

export interface CliAssignmentBot {
  id: string
  backendId?: string
  executionAgent?: { backendId?: string }
  agentsMdIds?: readonly string[]
}

export interface LocalCliAgentsMdMigration {
  next: Record<string, string[]>
  /** Bots whose ids were copied onto a local CLI and can be cleared. */
  clearBotIds: string[]
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
}

export function normaliseLocalCliAgentsMd(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string[]> = {}
  for (const [id, files] of Object.entries(value as Record<string, unknown>)) {
    if (!cliById(id)) continue
    const list = unique(Array.isArray(files) ? files.filter((item): item is string => typeof item === 'string') : []).slice(0, 40)
    if (list.length) next[id] = list
  }
  return next
}

/** CLIs this Bot runs. The chat backend and the execution CLI both count. */
export function localCliIdsForBot(bot: CliAssignmentBot): string[] {
  const ids = [bot.backendId, bot.executionAgent?.backendId].filter((id): id is string => typeof id === 'string' && !!cliById(id))
  return [...new Set(ids)]
}

export function localCliAgentsMdMigration(current: Record<string, string[]> | undefined, bots: readonly CliAssignmentBot[]): LocalCliAgentsMdMigration {
  const next = normaliseLocalCliAgentsMd(current)
  const clearBotIds: string[] = []
  for (const bot of bots) {
    const ids = unique(bot.agentsMdIds ?? [])
    const clis = localCliIdsForBot(bot)
    if (!ids.length || !clis.length) continue
    for (const cli of clis) next[cli] = unique([...(next[cli] ?? []), ...ids]).slice(0, 40)
    clearBotIds.push(bot.id)
  }
  return { next, clearBotIds }
}

/** Files for this turn. A local CLI reads its assignment; anything still on the Bot is included until migration clears it. */
export function agentsMdIdsForTurn(bot: { backendId?: string; agentsMdIds?: readonly string[] }, settings: { localCliAgentsMd?: Record<string, readonly string[]> }): string[] {
  const cli = bot.backendId && cliById(bot.backendId) ? bot.backendId : ''
  const assigned = cli ? settings.localCliAgentsMd?.[cli] ?? [] : []
  return unique(cli ? [...assigned, ...(bot.agentsMdIds ?? [])] : (bot.agentsMdIds ?? []))
}
