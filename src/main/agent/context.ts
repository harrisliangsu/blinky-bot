/**
 * Assembles the message array sent to the model.
 *
 * Composition lives in `systemPrompt.ts`, conversion in `history.ts`, windowing in
 * `budget.ts`; this module wires them together and applies the per-session gates
 * (mode, computer-use permission) to the tool list.
 */

import type { Bot, MemoryEntry, Session, Settings, ToolSchema } from '../../shared/types'
import type { ProviderMessage } from './contracts'
import { applyBudget, contextWindowOr } from './budget'
import { groupBlocks, toProviderMessages } from './history'
import { filterToolsForMode } from './modes'
import { composeSystemPrompt } from './systemPrompt'
import { estimateTokens } from './tokens'
import { rankMemory } from './memoryRecall'

export interface ContextInput {
  session: Session
  bot: Bot
  settings: Settings
  /** Memory entries for the active bot, any order. */
  memory: MemoryEntry[]
  /** Registry schemas plus enabled built-ins, before mode filtering. */
  schemas: ToolSchema[]
  /** Every bot in the session, including this one. */
  roster: Bot[]
  contextWindow?: number
  supportsVision: boolean
  /** Handoff note, routine brief — appended to the system prompt. */
  extras?: string[]
}

export interface BuiltContext {
  /** `messages[0]` is the system message. */
  messages: ProviderMessage[]
  systemPrompt: string
  /** Tools the model may use this turn, after mode and permission filtering. */
  tools: ToolSchema[]
  /** History messages replaced by the trim summary. */
  dropped: number
  estimatedTokens: number
}

export function buildContext(input: ContextInput): BuiltContext {
  const contextWindow = contextWindowOr(input.contextWindow)
  const tools = availableTools(input.schemas, input.session, input.bot)

  const systemPrompt = composeSystemPrompt({
    bot: input.bot,
    session: input.session,
    settings: input.settings,
    // Ignore internal task-result messages: their contents are not the user's
    // current topic and must not steer retrieval of unrelated memories.
    memory: rankMemory(input.memory, [...(input.session.messages ?? [])].reverse().find((message) => message.role === 'user' && !message.internal)?.content ?? ''),
    schemas: tools,
    roster: input.roster,
    contextWindow,
    extras: input.extras
  })

  const history = toProviderMessages(input.session.messages ?? [], {
    supportsVision: input.supportsVision,
    // Only a shared conversation needs speaker labels; a solo bot would just be
    // reading its own name back at itself.
    speakerNames: input.roster.length > 1 ? nameById(input.roster) : undefined,
    selfBotId: input.bot.id
  })
  const budgeted = applyBudget(groupBlocks(history), estimateTokens(systemPrompt), contextWindow)

  return {
    messages: [{ role: 'system', content: systemPrompt }, ...budgeted.messages],
    systemPrompt,
    tools,
    dropped: budgeted.dropped,
    estimatedTokens: budgeted.estimatedTokens
  }
}

/** Mode gate first, then the bot's computer-use permission. */
export function availableTools(schemas: ToolSchema[], session: Session, bot: Bot): ToolSchema[] {
  const byMode = filterToolsForMode(dedupe(schemas), session.mode)
  return bot.computerUse ? byMode : byMode.filter((schema) => !schema.computerUse)
}

function nameById(roster: Bot[]): ReadonlyMap<string, string> {
  return new Map(roster.map((bot) => [bot.id, bot.name]))
}

function dedupe(schemas: ToolSchema[]): ToolSchema[] {
  const seen = new Set<string>()
  const out: ToolSchema[] = []
  for (const schema of schemas) {
    if (!schema?.name || seen.has(schema.name)) continue
    seen.add(schema.name)
    out.push(schema)
  }
  return out
}
