import type { Bot } from '../../shared/types'
import { agentsMdPrompt } from '../../shared/agentsMd'
import { readAgentsMdBodies } from './index'

/** Assigned AGENTS.md text for this turn, or '' when there is nothing to add. */
export async function agentsMdSection(bot: Pick<Bot, 'agentsMdIds'>): Promise<string> {
  const ids = bot.agentsMdIds ?? []
  if (!ids.length) return ''
  try {
    return agentsMdPrompt(await readAgentsMdBodies(ids))
  } catch (error) {
    console.warn('[openbot/agents-md] skipped assigned files', error)
    return ''
  }
}
