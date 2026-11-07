/**
 * Loop-owned state changes, addressable by id.
 *
 * Two callers reach these: our own tool executor, and the MCP gateway that exposes
 * OpenBOT's distinctive tools to an agent CLI running its own loop. The CLI only knows
 * ids, so everything here loads what it needs and never assumes a live turn.
 *
 * Memory filtering, the handoff cap and the approval policy therefore apply identically
 * whichever side the call came from.
 */

import type { ApprovalRequest, Bot, MemoryEntry, TodoItem } from '../../shared/types'
import type { ApprovalKind } from './approvalPolicy'
import { applyTodos, normaliseTodos } from './builtinHandlers'
import { performHandoff, type HandoffResult } from './handoff'
import { bots, sessions } from './sessionGateway'
import { captureToolStep } from './recorder'
import { newId } from './ids'
import { rememberFact, type RememberOutcome } from './memory'
import { requestApproval } from './approval'
import { signalFor } from './cancel'

/** Store one durable fact, screened and deduped exactly as an in-loop call would be. */
export async function remember(
  botId: string,
  text: string,
  source: MemoryEntry['source'] = 'run',
  tags?: string[]
): Promise<RememberOutcome> {
  return rememberFact(botId, text, source, tags)
}

/** Accepts a full entry, as the tool layer's `ToolHost.saveMemory` hook does. */
export async function saveMemoryEntry(entry: MemoryEntry): Promise<RememberOutcome> {
  if (!entry?.botId || !entry.text) return { entry: null, reason: 'memory text is empty' }
  return rememberFact(entry.botId, entry.text, entry.source ?? 'run', entry.tags)
}

export async function setTodos(sessionId: string, todos: TodoItem[] | unknown): Promise<boolean> {
  const session = await sessions.get(sessionId)
  if (!session) return false
  await applyTodos(session, normaliseTodos(todos))
  return true
}

/** Hand a session to another bot. Enforces the roster check and the consecutive cap. */
export async function handoff(
  sessionId: string,
  fromBotId: string,
  toBotId: string,
  reason: string,
  note?: string
): Promise<HandoffResult> {
  const session = await sessions.get(sessionId)
  if (!session) return { ok: false, message: 'Handoff failed: that session no longer exists.' }

  const from = await bots.get(fromBotId)
  if (!from) return { ok: false, message: 'Handoff failed: the sending bot no longer exists.' }

  return performHandoff(session, from, {
    id: newId('call'),
    name: 'handoff',
    args: { to: toBotId, reason, note }
  })
}

export async function listBots(): Promise<Bot[]> {
  return bots.list()
}

/**
 * Route an approval through the policy engine. Used by the MCP gateway to answer a
 * permission request raised by a CLI's own loop.
 */
export async function approve(input: {
  sessionId: string
  toolName: string
  target: string
  kind: ApprovalKind
  summary: string
  detail: string
  preview?: string
  /** The raising tool declared this destructive: confirm it whatever the policy says. */
  force?: boolean
  requestId?: string
}): Promise<boolean> {
  const outcome = await requestApproval({
    ...input,
    signal: signalFor(input.sessionId)
  })
  return outcome.approved
}

/** Full-request form, matching the tool layer's `ctx.requestApproval` signature. */
export async function approveRequest(
  request: ApprovalRequest,
  target: string
): Promise<boolean> {
  return approve({
    sessionId: request.sessionId,
    toolName: request.toolName,
    target,
    kind: request.kind,
    summary: request.summary,
    detail: request.detail,
    preview: request.preview,
    force: request.force === true,
    requestId: request.id
  })
}

/**
 * Record a step while a routine is being recorded. Reachable from the gateway so a CLI
 * driving our computer-use tools still produces a replayable routine.
 */
export function noteRoutineStep(input: Parameters<typeof captureToolStep>[0]): void {
  captureToolStep(input)
}
