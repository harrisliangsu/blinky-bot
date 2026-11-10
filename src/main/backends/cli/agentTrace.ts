import type { AgentTrace } from '../../../shared/chat'
import { redactSecrets } from '../vaultRedaction'

const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential)/i
const LIMIT = 100_000

/** Best-effort redaction; arbitrary tool output may still contain private data. */
export function agentTraceEntry(id: string, kind: string, phase: AgentTrace['phase'], raw: unknown): AgentTrace {
  let detail: string
  try {
    detail = JSON.stringify(raw, (key, value: unknown) => {
      if (key && SENSITIVE_KEY.test(key)) return '[redacted]'
      return typeof value === 'string' ? redactSecrets(value) : value
    }) ?? ''
  } catch { detail = '[Unable to display tool activity]' }
  // Also check serialized numbers/keys before truncation; JSON numbers can be
  // private card values even when the string replacer did not visit them.
  detail = redactSecrets(detail)
  if (detail.length > LIMIT) detail = `${detail.slice(0, LIMIT)}\n[内容过长，已截断]`
  return { id: id || kind, kind, phase, detail }
}

export function safeToolSummary(input: Record<string, unknown>): string {
  return Object.entries(input).slice(0, 3).map(([key, value]) => {
    const safe = SENSITIVE_KEY.test(key) ? '[redacted]' : agentTraceEntry('', '', 'started', value).detail.slice(0, 60)
    return `${key}=${safe}`
  }).join(', ')
}
