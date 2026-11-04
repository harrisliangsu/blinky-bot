/**
 * Identity of a warm Codex app-server.
 *
 * Kept apart from the transport so tests can check the key without loading
 * the JSON-RPC peer (parameter properties the strip-only test runner rejects).
 */

import { createHash } from 'node:crypto'

export interface CodexPoolIdentity {
  binaryPath: string
  cwd: string
  model: string
  /** Reasoning effort, so two depths do not share one warm thread. */
  effort?: string
  sessionKey: string
  args: readonly string[]
  env: Record<string, string>
}

/** Bearer tokens are hashed so the map key never holds the secret itself. */
export function codexPoolKey(id: CodexPoolIdentity): string {
  const envKey = createHash('sha256').update(JSON.stringify(id.env)).digest('hex')
  return JSON.stringify([id.binaryPath, id.cwd, id.model, id.effort ?? '', id.sessionKey, [...id.args], envKey])
}
