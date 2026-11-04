/**
 * Detection shared by cloud providers.
 *
 * There is no account system and no hosted backend of our own: a cloud backend
 * is usable exactly when the user has supplied a key for it, and the key is
 * only ever sent to that provider's own origin — `keyHost.ts` withholds it from
 * anywhere else, so a custom base URL cannot turn a stored credential into a
 * request to a host the user never chose.
 */

import { englishArticle } from '../../shared/englishArticle'
import { DETECT_TIMEOUT_MS, withTimeout } from './httpClient'
import { errorMessage, isOffline, keyRejectionDetail } from './httpErrors'
import { type OaEndpoint, listOpenAiModels } from './openaiCompat'
import type { DetectResult } from './types'
import { displayHost } from './urls'

export interface CloudProbeOptions {
  label: string
  endpoint: OaEndpoint
  /** Where the user gets a key, e.g. `platform.openai.com/api-keys`. */
  keyHint: string
  /** Listing path relative to the base URL. */
  probePath?: string
}

export function needsKey(label: string, keyHint: string): DetectResult {
  return {
    status: 'needs-key',
    detail: `API key required — add ${englishArticle(label)} ${label} key in Settings (${keyHint}). It is stored locally, encrypted by the OS credential store, and sent only to ${label}'s own API host.`
  }
}

export async function detectCloud(opts: CloudProbeOptions): Promise<DetectResult> {
  const { label, endpoint, keyHint } = opts
  if (!endpoint.apiKey?.trim()) return needsKey(label, keyHint)

  try {
    const models = await listOpenAiModels(
      endpoint,
      withTimeout(undefined, DETECT_TIMEOUT_MS),
      opts.probePath
    )
    return {
      status: 'available',
      detail: models.length
        ? `Key accepted — ${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'Key accepted.'
    }
  } catch (err) {
    const rejected = keyRejectionDetail(err, label)
    if (rejected) {
      // A rate limit means the key works; anything else means it does not.
      return { status: /429/.test(rejected) ? 'error' : 'needs-key', detail: rejected }
    }
    if (isOffline(err)) {
      return {
        status: 'error',
        detail: `Could not reach ${displayHost(endpoint.baseUrl)} — check your network connection.`
      }
    }
    return { status: 'error', detail: `${label} check failed: ${errorMessage(err)}` }
  }
}
