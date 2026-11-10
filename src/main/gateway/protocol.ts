/**
 * MCP method dispatch.
 *
 * Implemented: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
 * `tools/call`, `notifications/cancelled`, plus empty `resources/*` and
 * `prompts/*` listings so clients that probe them do not log errors against a
 * server that only advertises tools.
 *
 * The protocol version is echoed when the client asks for one we know, which is
 * what the spec prescribes and what keeps three different vendors' clients
 * happy against one server.
 */

import type { Grant } from './tokens'
import { assignMcpSessionId } from './tokens'
import { describeTools, sessionMode } from './descriptors'
import { invokeTool } from './invoke'
import { taskJudgmentScope } from '../agent/taskJudgmentScope'
import {
  type JsonRpcMessage,
  type JsonRpcResponse,
  RPC_ERROR,
  failure,
  idOf,
  paramsOf,
  success
} from './rpc'

export const SERVER_NAME = 'openbot'
export const IMPLEMENTATION_VERSION = '1.0.0'

/** Newest first; the first entry is what we answer with when asked for an unknown one. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
] as const

const INSTRUCTIONS =
  'BlinkyBot exposes this bot\'s own tools: durable memory (remember), bot-to-bot handoff, ' +
  'filesystem and shell access scoped to the session directory, and computer use — screenshot, ' +
  'click, type_text, key_press, scroll, drag, open_app, navigate. Take a screenshot before and ' +
  'after any computer-use action; all coordinates are in the pixel space of the most recent ' +
  'screenshot, origin top-left. Actions that change something are shown to the user for approval ' +
  'first, so a refusal is an answer, not an error to retry.'

/** Requests still running, so `notifications/cancelled` can stop them. */
const inFlight = new Map<string, AbortController>()

function inFlightKey(grant: Grant, id: unknown): string {
  return `${grant.token}:${String(id)}`
}

/** Abort `child` when `parent` aborts, without leaking the listener. */
function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) child.abort()
  const onAbort = (): void => child.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  return () => parent.removeEventListener('abort', onAbort)
}

function negotiateVersion(requested: unknown): string {
  const list: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS
  return typeof requested === 'string' && list.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0]
}

function initializeResult(grant: Grant, params: Record<string, unknown>): unknown {
  assignMcpSessionId(grant)
  return {
    protocolVersion: negotiateVersion(params['protocolVersion']),
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: SERVER_NAME, title: 'BlinkyBot', version: IMPLEMENTATION_VERSION },
    instructions: INSTRUCTIONS
  }
}

async function callTool(
  grant: Grant,
  params: Record<string, unknown>,
  id: string | number,
  connection?: AbortSignal
): Promise<JsonRpcResponse> {
  const name = params['name']
  if (typeof name !== 'string' || !name.trim()) {
    return failure(id, RPC_ERROR.invalidParams, '`name` is required and must be a string.')
  }
  const raw = params['arguments']
  const args = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}

  // The call stops when the session is revoked, when the client cancels, or
  // when it drops the connection it was waiting on.
  const controller = new AbortController()
  const unlink = [grant.abort.signal, connection]
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .map((signal) => linkAbort(signal, controller))
  const key = inFlightKey(grant, id)
  inFlight.set(key, controller)
  try {
    return success(id, await invokeTool(grant, name.trim(), args, controller.signal))
  } finally {
    inFlight.delete(key)
    for (const off of unlink) off()
  }
}

/** Returns null for notifications, which carry no reply. */
export async function dispatch(
  grant: Grant,
  message: JsonRpcMessage,
  connection?: AbortSignal
): Promise<JsonRpcResponse | null> {
  const method = typeof message.method === 'string' ? message.method : ''
  const params = paramsOf(message)
  const id = idOf(message)

  if (method === 'notifications/cancelled') {
    inFlight.get(inFlightKey(grant, params['requestId']))?.abort()
    return null
  }
  if (method.startsWith('notifications/')) return null

  // A message with no id and no notification method is a response to us; we
  // never send requests to the client, so there is nothing to correlate.
  if (id === null) return null

  switch (method) {
    case 'initialize':
      return success(id, initializeResult(grant, params))
    case 'ping':
      return success(id, {})
    case 'tools/list':
      /* The mode is read per request rather than baked into the grant: a grant
         is minted once per turn, but the user can switch to Ask or Plan while
         the CLI is still running, and the list it asks for next must reflect
         that. `invokeTool` refuses a mutating tool in a read-only mode anyway —
         this is the other half of the double gate, withholding it from the
         model's list in the first place. */
      return success(id, {
        // Registry defaults add clarification/review tools even to [].
        // Private judgment advertises no App capabilities, including defaults.
        tools: taskJudgmentScope(grant.sessionId) ? [] : describeTools(grant.tools, grant.computerTarget, sessionMode(grant.sessionId))
      })
    case 'tools/call':
      return callTool(grant, params, id, connection)
    case 'resources/list':
      return success(id, { resources: [] })
    case 'resources/templates/list':
      return success(id, { resourceTemplates: [] })
    case 'prompts/list':
      return success(id, { prompts: [] })
    case 'logging/setLevel':
      return success(id, {})
    default:
      return failure(id, RPC_ERROR.methodNotFound, `Unknown method "${method}".`)
  }
}

/** Drop cancellation bookkeeping for a revoked grant. */
export function abortInFlight(grant: Grant): void {
  for (const [key, controller] of [...inFlight.entries()]) {
    if (!key.startsWith(`${grant.token}:`)) continue
    controller.abort()
    inFlight.delete(key)
  }
}

/** The `tools/list_changed` notification, for callers that re-scope a grant. */
export function toolsChangedNotification(): unknown {
  return { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
}
