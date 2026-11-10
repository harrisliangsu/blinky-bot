/**
 * Per-thread bearer tokens.
 *
 * One token per bot/session pair. Every request to the gateway must present it,
 * and the token is the *only* thing that says which bot a `tools/call` belongs
 * to — cwd, computer target and the enabled tool list all hang off the grant, so
 * a call can never be attributed to the wrong bot or reach a tool the bot has
 * not been given.
 *
 * Tokens live in memory only. They are never written to a config file, never
 * logged, and are revoked the moment their session ends (which also aborts any
 * tool call still running for it).
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ComputerTarget } from '../../shared/types'

/** 256 bits, url-safe: survives headers, TOML and JSON without escaping. */
const TOKEN_BYTES = 32

export interface GrantInput {
  botId: string
  sessionId: string
  /** Working directory tools resolve against; paths may not escape it. */
  cwd: string
  /** Tool ids the bot has enabled (`Bot.tools`). Nothing else is ever exposed. */
  tools: string[]
  /** `Bot.computerUse` — screen capture and input injection. */
  computerUse: boolean
  /** `Bot.computerTarget`. Defaults to this host. */
  computerTarget?: ComputerTarget
  /** Assistant message the CLI's tool activity hangs off, when one is known. */
  messageId?: string
}

export interface Grant {
  readonly token: string
  readonly botId: string
  readonly sessionId: string
  readonly cwd: string
  readonly tools: string[]
  readonly computerUse: boolean
  readonly computerTarget: ComputerTarget
  readonly createdAt: number
  /** Assigned at `initialize` and echoed as `Mcp-Session-Id`. Never the token. */
  mcpSessionId?: string
  messageId?: string
  /** Aborted on revocation so in-flight tool calls stop with the session. */
  readonly abort: AbortController
}

const byToken = new Map<string, Grant>()

/** Identity of a computer target, ignoring secrets that rotate on their own. */
export function targetScope(target: ComputerTarget | undefined): string {
  const value = target ?? { kind: 'local' as const }
  if (value.kind === 'vm') return `vm\0${value.vmId}\0${value.endpoint}`
  if (value.kind === 'browser') return `browser\0${value.botId}`
  return 'local'
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((item, index) => item === b[index])
}

/**
 * True when this grant still describes the bot about to run.
 * A match lets the next turn keep the same bearer token, which is what a
 * warm CLI process was started with.
 */
export function grantCovers(grant: Grant, input: GrantInput): boolean {
  return (
    grant.botId === input.botId &&
    grant.sessionId === input.sessionId &&
    grant.cwd === input.cwd &&
    grant.computerUse === input.computerUse &&
    sameTools(grant.tools, input.tools) &&
    targetScope(grant.computerTarget) === targetScope(input.computerTarget)
  )
}

export function mintGrant(input: GrantInput): Grant {
  const grant: Grant = {
    token: randomBytes(TOKEN_BYTES).toString('base64url'),
    botId: input.botId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    tools: [...input.tools],
    computerUse: input.computerUse,
    computerTarget: input.computerTarget ?? { kind: 'local' },
    createdAt: Date.now(),
    messageId: input.messageId,
    abort: new AbortController()
  }
  byToken.set(grant.token, grant)
  return grant
}

/** Byte-for-byte comparison that does not return early. */
function secretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The grant a bearer token names, matched in constant time.
 *
 * A `Map.get` compares hashed keys and stops at the first differing byte, which
 * is a timing oracle on the one secret that decides which bot a `tools/call`
 * belongs to. The token is 256 bits of randomness so guessing it a byte at a
 * time is not a practical attack — this is the same discipline the VM daemon
 * already applies to its own bearer token, and the loop deliberately visits
 * every grant rather than stopping at the match.
 */
export function grantForToken(token: string): Grant | undefined {
  if (!token) return undefined
  let found: Grant | undefined
  for (const [candidate, grant] of byToken) {
    if (secretEqual(candidate, token)) found = grant
  }
  return found
}

/** Called at `initialize`; stable for the life of the grant. */
export function assignMcpSessionId(grant: Grant): string {
  grant.mcpSessionId ??= randomUUID()
  return grant.mcpSessionId
}

export function grantsForSession(sessionId: string): Grant[] {
  return [...byToken.values()].filter((g) => g.sessionId === sessionId)
}

/** Point later tool events at a new assistant message. */
export function setGrantMessage(sessionId: string, messageId: string | undefined): void {
  for (const grant of grantsForSession(sessionId)) grant.messageId = messageId
}

export function revokeToken(token: string): boolean {
  const grant = byToken.get(token)
  if (!grant) return false
  byToken.delete(token)
  grant.abort.abort()
  return true
}

/** Revoke everything a session holds. Returns how many grants were dropped. */
export function revokeSession(sessionId: string): number {
  let count = 0
  for (const grant of grantsForSession(sessionId)) {
    if (revokeToken(grant.token)) count++
  }
  return count
}

export function revokeAllGrants(): number {
  let count = 0
  for (const token of [...byToken.keys()]) {
    if (revokeToken(token)) count++
  }
  return count
}

/** A tool withdrawal invalidates existing CLI sessions as well as the next turn. */
export function revokeBotGrants(botId: string): number {
  let count = 0
  for (const grant of byToken.values()) if (grant.botId === botId && revokeToken(grant.token)) count++
  return count
}

export function activeGrantCount(): number {
  return byToken.size
}

/** Safe to log: identifies the grant without revealing the token. */
export function describeGrant(grant: Grant): string {
  return `bot ${grant.botId} / session ${grant.sessionId}`
}
