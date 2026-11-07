/** Optional model-only routing advice. The lead remains responsible for every action. */
import type { BackendKind, Settings } from '../../shared/types'
import { scrubVaultJson, scrubVaultTranscript } from '../store/vaultPrivacy'
import { getBackend, runSideCall } from './backendGateway'

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

function parsedHint(value: Awaited<ReturnType<typeof runSideCall>>): QuickDecisionHint | null {
  if (!value || value.calls.length || typeof value.text !== 'string' || value.text.length > 4096) return null
  let parsed: unknown
  try { parsed = JSON.parse(value.text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'route' && key !== 'reason') || !['inline','delegate','clarify'].includes(String(record.route)) || typeof record.reason !== 'string') return null
  const reason = scrubVaultTranscript(record.reason).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 180)
  if (!reason) return null
  return { route: record.route as QuickDecisionHint['route'], reason }
}

/** Disabled, unavailable, invalid, cancelled and timed-out advice all fall back silently. */
export async function quickDecisionHint(_input: QuickDecisionInput): Promise<QuickDecisionHint | null> {
  // Retired preference is retained for compatibility; it must never start a hidden side call.
  return null
}
