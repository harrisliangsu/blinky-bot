/** Bot memory reads/writes, over `store/memory`. */

import type { MemoryEntry } from '../../shared/types'
import { addBotMemoryDurable, listBotMemory } from '../store/memory'
import { errorMessage } from './errors'

export const memoryStore = {
  async list(botId: string): Promise<MemoryEntry[]> {
    try {
      return listBotMemory(botId)
    } catch (err) {
      console.warn(`[agent] memory read failed: ${errorMessage(err)}`)
      return []
    }
  },

  /** Returns the stored entry, or null when persistence failed. */
  async add(
    botId: string,
    text: string,
    source: MemoryEntry['source'],
    tags?: string[]
  ): Promise<MemoryEntry | null> {
    try {
      return await addBotMemoryDurable(botId, text, source, tags)
    } catch (err) {
      console.warn(`[agent] memory save failed: ${errorMessage(err)}`)
      return null
    }
  }
}
