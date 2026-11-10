/** Legacy routing types retained for settings compatibility; inference is retired. */
import type { BackendKind, Settings } from '../../shared/types'

export interface QuickDecisionConfig { backendId: string; modelId: string }
export interface QuickDecisionHint { route: 'inline' | 'delegate' | 'clarify'; reason: string }
export interface QuickDecisionInput {
  settings: Settings & { quickDecision?: QuickDecisionConfig | null }
  request: string
  context?: Array<{ role: 'user' | 'assistant'; text: string }>
  cwd: string
  signal: AbortSignal
}

export const QUICK_DECISION_TIMEOUT_MS = 8_000

/** Other native CLIs have not established an equivalent tool-free side-call path. */
export function supportsQuickDecisionBackend(backend: { id: string; kind: BackendKind }): boolean {
  return backend.kind === 'cloud-api' || backend.kind === 'local-server' || (backend.id === 'pi' && backend.kind === 'agent-cli')
}

/** Saved values cannot start another model or tool loop. */
export async function quickDecisionHint(_input: QuickDecisionInput): Promise<QuickDecisionHint | null> {
  // Retired preference is retained for compatibility; it must never start a hidden side call.
  return null
}
