/** Bots: agent personas with their own model, tools and durable memory. */

import type { ComputerTarget } from './computer'
import type { ThinkingDepth } from './thinking'

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
  /**
   * When true, this Bot follows Settings' default CLI, that CLI's default
   * model, and the default thinking depth. Absent on older files: a generic
   * `default` model still follows.
   */
  followsDefault?: boolean
  /**
   * How hard this Bot thinks. Only sent when the chosen CLI or provider
   * accepts a depth. Absent means that backend's own default. Ignored while
   * `followsDefault` is set — Settings' default depth wins then.
   */
  thinking?: ThinkingDepth
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
