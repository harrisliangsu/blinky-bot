/** Bots: agent personas with their own model, tools and durable memory. */

import type { ComputerTarget } from './computer'
import type { ThinkingDepth } from './thinking'
import type { AvatarShapeId, AvatarColorId } from './botAvatars'

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
  /** Absent/empty retains the original custom emoji identity. */
  avatarShape?: AvatarShapeId | ''
  avatarColor?: AvatarColorId | ''
  backendId: string
  modelId: string
  /** Optional independently configured runtime for delegated execution. */
  executionAgent?: { backendId: string; modelId: string; thinking?: ThinkingDepth; accessMode?: 'full-access' }
  /** @deprecated Legacy input only. Ignored and removed on load/save. */
  executionAgentDisabled?: boolean
  /**
   * Legacy migration marker. Old followers are frozen to their effective
   * choice when loaded; newly saved Bots keep independent selections.
   */
  followsDefault?: boolean
  /**
   * How hard this Bot thinks. Only sent when the chosen CLI or provider
   * accepts a depth. Absent means that backend's own default. Ignored while
   * `followsDefault` is set — Settings' default depth wins then.
   */
  thinking?: ThinkingDepth
  /**
   * Route this Bot's conversation model over the provider's fast channel.
   * Only shown for providers with a real fast lane, and only sent when the
   * chosen model accepts it; every other backend ignores it.
   */
  fast?: boolean
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
