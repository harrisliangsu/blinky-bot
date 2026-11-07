/**
 * Out-of-workspace access the user granted this session.
 *
 * Kept apart from path resolution because it is the security-sensitive half:
 * resolution answers "where does this point", this answers "may we".
 */

import { isInside } from './containment'
import { settingsOf } from './settings'
import type { ToolContext } from './types'

/**
 * Out-of-workspace roots the user approved this session, per mode.
 *
 * The mode is the whole point. A single set of bare paths meant approving a
 * *read* of one directory silently granted everything underneath it for every
 * later tool — including writes. Answering "search my home folder" once made
 * `write_file ~/Library/LaunchAgents/x.plist` run with no card at all, because
 * the grant erased the `outside` flag that the forced approval depends on.
 * A read grant now satisfies only reads.
 */
const approvedRoots = new Map<string, Map<string, Set<AccessMode>>>()

export type AccessMode = 'read' | 'write'


export function rememberRoot(sessionId: string, path: string, mode: AccessMode): void {
  const roots = approvedRoots.get(sessionId) ?? new Map<string, Set<AccessMode>>()
  const modes = roots.get(path) ?? new Set<AccessMode>()
  modes.add(mode)
  // A write grant implies the read that goes with it; the reverse never holds.
  if (mode === 'write') modes.add('read')
  roots.set(path, modes)
  approvedRoots.set(sessionId, roots)
}

export function alreadyApproved(sessionId: string, path: string, mode: AccessMode): boolean {
  const roots = approvedRoots.get(sessionId)
  if (!roots) return false
  for (const [root, modes] of roots) if (modes.has(mode) && isInside(root, path)) return true
  return false
}

/** Drop cached approvals for a finished session. */
export function forgetSession(sessionId: string): void {
  approvedRoots.delete(sessionId)
}

/**
 * Record a root the caller's own approval already covered.
 *
 * The mode must match what the user was actually shown. `shell` records reads
 * even for a command that could write, because the card named one command —
 * not standing permission to write there for the rest of the session.
 */
export function noteApprovedTarget(ctx: ToolContext, outside: string, mode: AccessMode): void {
  // Auto-run permission is policy-scoped, not a user-approved session grant.
  // Switching back to a prompting policy must take effect on the next call.
  if (settingsOf(ctx).approvalPolicy === 'auto-run') return
  rememberRoot(ctx.sessionId, outside, mode)
}
