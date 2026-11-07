/**
 * Binding a provider API key to that provider's own host.
 *
 * `baseUrl` is user-editable and was accepted as any string, so a typo — or a
 * settings file written by something other than OpenBOT — could point a cloud
 * adapter at an arbitrary host while the decrypted key rode along with it as
 * `Authorization: Bearer` or `x-api-key`. Detection tells the user the key "is
 * stored locally and sent only to <provider>"; this module is what makes that
 * sentence true. The key is withheld unless the configured base URL is the
 * provider's own origin, and the caller reports why rather than quietly
 * retrying the request with no credential at all.
 */

import { PROVIDER_CATALOG } from '../../shared/providerCatalog'
import { displayHost } from './urls'

/** Scheme, host and port, lowercased. `null` when the URL will not parse. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    const { origin } = parsed
    // Opaque origins serialise as the literal string `null`; two of those must
    // never compare equal to each other.
    return origin && origin !== 'null' ? origin.toLowerCase() : null
  } catch {
    return null
  }
}

/** A custom credential is only sent to the origin explicitly saved with it. */
export function bindCustomKey(baseUrl: string, apiKey: string | undefined, credentialOrigin: string | undefined): HostBoundKey {
  const origin = originOf(baseUrl)
  if (!origin) return { baseUrl, withheld: 'Invalid provider URL. Use an HTTP(S) URL without embedded credentials.' }
  const key = apiKey?.trim()
  if (!key) return { baseUrl }
  if (!credentialOrigin || origin !== credentialOrigin) {
    return { baseUrl, withheld: 'Provider address changed. Re-enter the API key to use this endpoint.' }
  }
  return { baseUrl, apiKey: key }
}

let origins: Map<string, string> | null = null

/**
 * The canonical origin per backend, taken from the provider catalog so there
 * is only ever one copy of each host.
 *
 * Built on first use so importing this module cannot cycle through a catalog
 * entry that is still evaluating.
 */
function canonicalOrigins(): Map<string, string> {
  if (!origins) {
    origins = new Map()
    for (const provider of PROVIDER_CATALOG) {
      const origin = originOf(provider.baseUrl)
      if (origin) origins.set(provider.id, origin)
    }
  }
  return origins
}

/** The one origin a given backend's key may ever be sent to, if it has one. */
export function canonicalOriginFor(backendId: string): string | undefined {
  return canonicalOrigins().get(backendId)
}

/**
 * Whether `baseUrl` is the provider's own origin.
 *
 * Fails closed: a URL that will not parse, a different host, a different port,
 * or a downgrade from `https` to plain `http` all answer no. The cost of being
 * wrong here is a leaked credential, so anything short of an exact match on the
 * origin is treated as somewhere else.
 */
export function maySendKeyTo(backendId: string, baseUrl: string): boolean {
  const expected = canonicalOriginFor(backendId)
  // No canonical origin means no binding to enforce — local servers are
  // deliberately pointed at whatever host the user is running them on.
  if (!expected) return true
  return originOf(baseUrl) === expected
}

export interface HostBoundKey {
  /** Unchanged: binding withholds the key, it never rewrites the endpoint. */
  baseUrl: string
  /** The key to send, or absent when `baseUrl` is not the provider's own. */
  apiKey?: string
  /** Set only when a key exists and was withheld — ready to show to the user. */
  withheld?: string
}

/** Wording for a key we refused to send, aimed at the setting that caused it. */
function withheldDetail(backendId: string, label: string, baseUrl: string): string {
  const expected = canonicalOriginFor(backendId)
  return (
    `BlinkyBot will not send your ${label} API key to ${displayHost(baseUrl)} — a provider key is only ` +
    `ever sent to ${expected ? displayHost(expected) : `${label}'s own host`}. Clear the custom base ` +
    `URL for ${label} in Settings to reconnect, or remove the ${label} key if that endpoint is ` +
    'where you meant to point it.'
  )
}

/**
 * Resolve the credential for one request: the key when the endpoint is the
 * provider's own, otherwise nothing plus the reason to show the user.
 */
export function bindKeyToHost(
  backendId: string,
  label: string,
  baseUrl: string,
  apiKey: string | undefined
): HostBoundKey {
  const key = apiKey?.trim()
  if (!key) return { baseUrl }
  if (maySendKeyTo(backendId, baseUrl)) return { baseUrl, apiKey: key }
  return { baseUrl, withheld: withheldDetail(backendId, label, baseUrl) }
}
