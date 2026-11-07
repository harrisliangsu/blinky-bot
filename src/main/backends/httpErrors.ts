/**
 * Error classification. Detection turns these into `BackendStatus` values,
 * so telling "nothing is listening" apart from "server said no" matters.
 */

import { redactSecrets } from './vaultRedaction'

export class HttpError extends Error {
  readonly status: number
  readonly body: string
  readonly url: string

  constructor(status: number, body: string, url: string) {
    // Redacted, and not only on the CLI path where `redactSecrets` started
    // life. Providers echo the offending request back in their error bodies —
    // an `Authorization` header, an `api_key` field — and this message becomes
    // a renderer-visible `statusDetail` and a console line without ever passing
    // through a redactor of its own.
    const safeUrl = redactSecrets(url)
    super(`HTTP ${status} from ${safeUrl}${body ? ` — ${redactSecrets(body).slice(0, 400)}` : ''}`)
    this.name = 'HttpError'
    this.status = status
    this.body = redactSecrets(body)
    this.url = safeUrl
  }
}

export function errorCode(err: unknown): string {
  const direct = (err as { code?: unknown } | null | undefined)?.code
  if (typeof direct === 'string') return direct
  const cause = (err as { cause?: unknown } | null | undefined)?.cause
  const causeCode = (cause as { code?: unknown } | null | undefined)?.code
  if (typeof causeCode === 'string') return causeCode
  const nested = (cause as { cause?: { code?: unknown } } | null | undefined)?.cause?.code
  if (typeof nested === 'string') return nested
  return err instanceof Error ? err.name : 'Error'
}

/**
 * The one funnel from a backend failure to a `statusDetail` and a log line, so
 * it redacts as well: an adapter that folds a provider response into a plain
 * `Error` — or a `fetch` cause that quotes the request — would otherwise arrive
 * here unfiltered. `redactSecrets` is idempotent, so redacting an `HttpError`
 * that already did it costs nothing.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    const causeMsg = cause instanceof Error ? cause.message : undefined
    return redactSecrets(
      causeMsg && causeMsg !== err.message ? `${err.message}: ${causeMsg}` : err.message
    )
  }
  return redactSecrets(String(err))
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || errorCode(err) === 'ABORT_ERR')
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') return true
  const code = errorCode(err)
  return (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'TimeoutError'
  )
}

/** Nothing is listening, or the host cannot be reached. */
export function isConnectionError(err: unknown): boolean {
  const code = errorCode(err)
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
  )
}

/** The endpoint is not serving right now — either unreachable or too slow. */
export function isOffline(err: unknown): boolean {
  return isConnectionError(err) || isTimeoutError(err)
}

/** Standard wording for a rejected or missing key. */
export function keyRejectionDetail(err: unknown, provider: string): string | null {
  if (!(err instanceof HttpError)) return null
  if (err.status === 401 || err.status === 403) {
    return `${provider} rejected the API key (HTTP ${err.status}) — check the key in Settings.`
  }
  if (err.status === 429) return `${provider} rate-limited this key (HTTP 429) — try again shortly.`
  return null
}
