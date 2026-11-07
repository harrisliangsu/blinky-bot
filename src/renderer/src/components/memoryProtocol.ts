import type { MemoryEntry } from '../../../shared/types'

/** User edits carry a stable receipt independently of the memory text. */
export async function writeMemory(botId: string, text: string, replaceEntryId?: string, shared = false, kind?: 'profile' | 'journal' | 'note'): Promise<MemoryEntry | null> {
  return window.openbot.bots.addMemory(botId, { text, replaceEntryId, requestId: crypto.randomUUID(), shared, ...(kind ? { kind } : {}) })
}
export async function forgetMemory(botId: string, entryId: string): Promise<boolean> {
  return window.openbot.bots.removeMemory(botId, entryId)
}
