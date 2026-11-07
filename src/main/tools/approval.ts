/**
 * The approval gate.
 *
 * Tools describe what they are about to do; the host renders it and returns a
 * verdict. `approve-always` bookkeeping belongs to the host — tools simply ask
 * again and trust the gate to answer without prompting.
 */

import { randomUUID } from 'node:crypto'
import { ApprovalDenied } from './errors'
import { settingsOf } from './settings'
import type { ApprovalDraft, ToolContext } from './types'

/**
 * Ask the user.
 *
 * The gate enforces the current policy and denylist; forced high-risk app
 * actions may still require confirmation during auto-run. A gate that throws
 * counts as a refusal.
 *
 * There is deliberately no `auto-run` fast path here. Answering yes without
 * reaching the gate also skipped the gate's denylist check, so a rule the user
 * wrote to forbid something was silently inert on that one policy for every
 * self-approving tool — only `shell` escaped, and only because it runs its own
 * refusal check first. `evaluate` already resolves `auto-run` without showing a
 * card, and checks the denylist before it does.
 */
export async function approve(
  ctx: ToolContext,
  draft: ApprovalDraft,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  try {
    /*
     * `force` reaches the gate so prompting policies can require confirmation
     * for actions that otherwise match an allow rule.
     */
    return await ctx.requestApproval({
      id: randomUUID(),
      sessionId: ctx.sessionId,
      ...draft,
      ...(opts.force ? { force: true } : {})
    })
  } catch {
    return false
  }
}

/** Throwing form of {@link approve}; the caller's handler turns it into `ok: false`. */
export async function requireApproval(
  ctx: ToolContext,
  draft: ApprovalDraft,
  opts: { force?: boolean } = {}
): Promise<void> {
  const granted = await approve(ctx, draft, opts)
  if (!granted) throw new ApprovalDenied(draft.summary)
}
