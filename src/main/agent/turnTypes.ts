/**
 * What one turn is asked for, and what it reports back.
 *
 * Separate from `turn.ts` so the modules that make up a turn — the request builder,
 * the ACTION-line reader — can name these without importing the runner they are
 * called from. `turn.ts` re-exports all of them, which is the address the rest of
 * the loop uses.
 */

import type { Bot, Message, Session, Settings } from '../../shared/types'
import type { TurnMode } from './backendMode'

export type TurnStatus = 'final' | 'tools' | 'handoff' | 'aborted' | 'error'

export interface TurnInput {
  session: Session
  bot: Bot
  settings: Settings
  signal: AbortSignal
  /** System-prompt additions for this turn only, such as an incoming handoff note. */
  extras?: string[]
  /** Message this turn answers, when a teammate handed over. */
  replyTo?: string | null
  /** Moderator instruction handing this bot the floor, appended as a user turn. */
  floor?: string | null
  /**
   * This turn is the retry after a moderator nudge. The reply is expected to
   * restate the previous one, so the cross-turn repetition guard is skipped —
   * otherwise the guard would swallow the very handoff the nudge asked for.
   */
  retry?: boolean
  /** Keep result-review turns out of the user-facing chat until assessed. */
  internalAssistant?: boolean
  /**
   * An MCP server to hand this turn's backend, on top of the user's own.
   *
   * How OpenBOT's tools reach an agent CLI running its own loop: the gateway
   * endpoint plus the bearer token minted for this bot and session.
   */
  gateway?: RuntimeMcpServer | null | Promise<RuntimeMcpServer | null>
  /** Called whenever the backend produces a chunk; resets the inactivity clock. */
  onActivity?: () => void
}

/** One MCP server an adapter can be given for a single turn. */
export interface RuntimeMcpServer {
  name: string
  transport: 'http'
  url: string
  /** Kept out of the URL so it never reaches a process listing or a log line. */
  bearerToken: string
}

export interface TurnResult {
  status: TurnStatus
  message: Message
  mode: TurnMode
  /** Set when `status` is `handoff`: the brief for the receiving bot's system prompt. */
  note?: string
  /** Set when `status` is `handoff`: the one-line ask, for the moderator's floor brief. */
  request?: string
  /** Multi-bot turn that produced no ACTION line, so the floor could not move. */
  actionMissing?: boolean
}
