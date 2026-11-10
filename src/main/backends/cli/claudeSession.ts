/**
 * Conversation continuity for Claude Code.
 *
 * Claude Code persists conversations itself, keyed by a session UUID, so we do
 * not need to hold a process open between turns. The first turn of an OpenBOT
 * session creates the id; later turns resume it, and the agent keeps its own
 * context — memory, plan, file knowledge — instead of starting cold each time.
 */

import { createHash } from 'node:crypto'
import { forgetProviderBinding, getProviderBinding, putProviderBinding } from '../../store/providerBindings'

/**
 * Derive a stable UUIDv4-shaped id from an arbitrary conversation key.
 *
 * `--session-id` demands a valid UUID, and OpenBOT session ids already are one
 * — but deriving rather than reusing keeps the two namespaces independent, so a
 * Claude conversation is never addressable by guessing an OpenBOT id.
 */
export function sessionUuid(sessionKey: string, restart = 0): string {
  const seed = restart > 0 ? `claude:${sessionKey}#${restart}` : `claude:${sessionKey}`
  const hex = createHash('sha256').update(seed).digest('hex')
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

/**
 * Flags that continue this session.
 * `--session-id` creates; `--resume` continues an existing conversation.
 *
 * `started` is persisted with the binding. It is set only after Claude has
 * actually accepted the id (the turn succeeded, or Claude reported the id
 * already in use). Setting it inside this function, before the CLI answered,
 * made the relaunch recovery refuse to switch from `--session-id` to `--resume`.
 */
export function continuityArgs(sessionKey: string | undefined): string[] {
  if (!sessionKey) return []
  const binding = getProviderBinding('claude', sessionKey)
  const restarts = binding?.restarts ?? 0
  const uuid = binding?.started && binding.nativeThreadId ? binding.nativeThreadId : sessionUuid(sessionKey, restarts)
  if (binding?.started && binding.nativeThreadId) return ['--resume', binding.nativeThreadId]
  return ['--session-id', uuid]
}

/** Remember that Claude accepted this conversation, so the next launch resumes it. */
export function confirmClaudeSession(sessionKey: string | undefined): void {
  if (!sessionKey) return
  const binding = getProviderBinding('claude', sessionKey)
  const restarts = binding?.restarts ?? 0
  putProviderBinding('claude', sessionKey, {
    nativeThreadId: sessionUuid(sessionKey, restarts),
    restarts,
    started: true
  })
}

/**
 * Adopt a conversation Claude Code already holds, so the next call resumes it.
 *
 * `started` lives in module memory while the conversation lives on Claude
 * Code's disk, and `sessionUuid` is deterministic — so after the app restarts,
 * the first turn of EVERY existing Claude Code chat offered `--session-id
 * <id Claude already has>`, which it refuses outright ("Session ID … is already
 * in use"). `claude.ts` only retried a failed `--resume`, and this is not one,
 * so the turn hard-failed with no recovery. The refusal is really Claude
 * telling us the conversation survived; joining it is what should have
 * happened. Returns false when the id was ours to begin with.
 */
export function adoptExistingSession(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false
  const binding = getProviderBinding('claude', sessionKey)
  if (binding?.started) return false
  const restarts = binding?.restarts ?? 0
  putProviderBinding('claude', sessionKey, {
    nativeThreadId: sessionUuid(sessionKey, restarts),
    restarts,
    started: true
  })
  return true
}

/**
 * Claude Code's own wording when `--session-id` names a conversation it holds
 * — `Error: Session ID <uuid> is already in use.` Matched loosely so a reworded
 * release degrades to the old behaviour rather than to a wrong retry.
 */
const SESSION_ID_IN_USE = /session id\b[^\n]*already in use/i

export function isSessionIdInUse(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return SESSION_ID_IN_USE.test(message)
}

/**
 * Restart a conversation so the next turn starts a fresh one. Called when a
 * resume fails — a conversation Claude has pruned must not be resumed forever.
 *
 * The next id is a NEW id, and the transcript watermark goes with it: the fresh
 * conversation holds none of the history the previous one was credited with.
 */
export function forgetSession(sessionKey: string | undefined): void {
  if (!sessionKey) return
  forgetProviderBinding('claude', sessionKey)
}

/**
 * Claude's print transport has no client-side permission callback. Keep it in
 * manual mode and restrict native tools in `claude.ts`; mutations are exposed
 * through OpenBOT's MCP gateway, where OpenBOT owns the approval decision.
 *
 * Claude Code has no client-side permission callback in this version, so its
 * own tools are governed by this mode rather than by OpenBOT's approval dialog.
 * `acceptEdits` is intentionally never returned: it silently approves writes,
 * contradicting OpenBOT's "Ask every time" policy. `auto` is unsafe for the
 * same reason because OpenBOT's forced confirmations would never see the call.
 */
export function permissionMode(policy: string | undefined): string {
  void policy
  return 'manual'
}

/**
 * Permission mode for a background side call, which never inherits the
 * session's.
 *
 * Post-turn memory extraction ran at `acceptEdits`, so a call whose only job is
 * to emit a JSON array could edit the user's files unattended — after the reply
 * had already been reported, with nobody watching. `plan` is Claude Code's own
 * read-only mode: it can look, it cannot change anything.
 */
export const READ_ONLY_PERMISSION_MODE = 'plan'
