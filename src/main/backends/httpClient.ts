/** Timeout-bounded JSON and streaming requests over global `fetch`. */

import { HttpError } from './httpErrors'
import { safeJsonParse } from './lenientJson'
import { MAX_LINE_CHARS } from './lineStream'
import { redactSecrets } from './vaultRedaction'

/** Detection runs on the startup path, so it must be short. */
export const DETECT_TIMEOUT_MS = 1500

/** Model listing is user-initiated and can afford a little more. */
export const LIST_TIMEOUT_MS = 6000

/** Combine a caller signal with a timeout so either can cancel the request. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timer]) : timer
}

/**
 * Read a whole response body, with a ceiling on it.
 *
 * `res.text()` buffers whatever the server chooses to send, so a broken or
 * hostile endpoint could hand back gigabytes and take the main process with it.
 * Overflow throws rather than truncating — a half-read body fed to a JSON
 * parser is a worse outcome than a failed request. A body that merely stops
 * mid-read is not an error: callers only ever wanted it to describe a failure,
 * which is why they used to `.catch(() => '')` around it.
 */
export async function readCappedText(res: Response, url: string): Promise<string> {
  // Some responses (and every hand-built one in a test) carry no stream.
  if (!res.body) return res.text().catch(() => '')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let overflowed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length > MAX_LINE_CHARS) {
        overflowed = true
        break
      }
    }
    if (!overflowed) text += decoder.decode()
  } catch {
    // Truncated by a dropped connection. Whatever arrived still describes the
    // response well enough for the caller's error path.
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed or aborted — nothing left to release.
    }
  }
  if (overflowed) {
    throw new Error(
      `Response body from ${url} exceeded ${MAX_LINE_CHARS} characters — refusing to buffer it.`
    )
  }
  return text
}

/**
 * Body text for a failed response, or the reason it could not be read.
 *
 * The status is the part detection classifies on — `keyRejectionDetail` turns a
 * 401 into "needs-key" — so an unreadable or over-long body must not replace
 * the `HttpError` with something that has no status on it.
 */
async function bodyForError(res: Response, url: string): Promise<string> {
  return readCappedText(res, url).catch((err) => (err instanceof Error ? err.message : ''))
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new HttpError(res.status, await bodyForError(res, url), url)
  const text = await readCappedText(res, url)
  if (!text.trim()) return {} as T
  const parsed = safeJsonParse<T>(text)
  // Redacted: this is provider text, and it becomes a renderer-visible
  // `statusDetail` and a console line the moment detection reports it.
  if (parsed === undefined) {
    throw new Error(`Invalid JSON from ${url}: ${redactSecrets(text.slice(0, 200))}`)
  }
  return parsed
}

/** POST JSON and return the streaming response, throwing on a non-2xx. */
export async function postForStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw new HttpError(res.status, await bodyForError(res, url), url)
  return res
}

/**
 * Resolve `promise`, or `fallback` if it takes longer than `ms`.
 * A hard ceiling so one wedged adapter cannot stall the whole detection pass.
 */
export async function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<T>((resolve) => {
    id = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, timer])
  } finally {
    if (id !== undefined) clearTimeout(id)
  }
}
