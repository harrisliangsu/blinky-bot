import type { Bot } from '../../shared/types'
import { agentsMdPrompt } from '../../shared/agentsMd'
import { agentsMdIdsForTurn } from '../../shared/localCliTools'
import { getSettings } from '../settings'
import { readAgentsMdBodies } from './index'

/** AGENTS.md for this turn's local CLI, or the Bot's own files when it is not a local CLI. */
export async function agentsMdSection(bot: Pick<Bot, 'agentsMdIds' | 'backendId'>): Promise<string> {
  const ids = agentsMdIdsForTurn(bot, getSettings())
  if (!ids.length) return ''
  try {
    return agentsMdPrompt(await readAgentsMdBodies(ids))
  } catch (error) {
    console.warn('[openbot/agents-md] skipped assigned files', error)
    return ''
  }
}
