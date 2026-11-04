/** Bots: agent personas with their own model, tools and durable memory. */

import type { ComputerTarget } from './computer'

export interface MemoryEntry {
  id: string
  botId: string
  text: string
  source: 'run' | 'user' | 'exchange'
  tags?: string[]
  createdAt: number
}

export interface Bot {
  id: string
  name: string
  description: string
  /** Persona / operating instructions. */
  systemPrompt: string
  emoji: string
  color: string
  backendId: string
  modelId: string
  /** Enabled tool ids; see TOOL_IDS. */
  tools: string[]
  /** Assigned skill ids (`origin:name`), resolved at prompt time. */
  skills?: string[]
  /** Grants screen capture + input injection. */
  computerUse: boolean
  /** Which machine this bot drives. Defaults to the host. */
  computerTarget: ComputerTarget
  archived?: boolean
  pinned?: boolean
  /**
   * This bot's one home conversation. Clicking the bot opens it. Clearing the
   * chat empties this conversation; it does not point the bot somewhere else.
   */
  activeConversationId?: string
  createdAt: number
  updatedAt: number
}

export interface AgentGroup {
  id: string
  name: string
  color: string
  botIds: string[]
  pinned?: boolean
  createdAt: number
  updatedAt: number
}

/** IPC-safe mutation result: handler failures remain visible without throwing across the bridge. */
export type BotSaveResult =
  | { ok: true; bot: Bot }
  | { ok: false; error: string }
