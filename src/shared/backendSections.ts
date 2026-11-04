/**
 * How Settings → Backends groups a registry row.
 *
 * Agent CLIs and cloud APIs share one list from `detectAll`. The settings
 * page splits them so a key field is not buried under every local command.
 */

import type { BackendKind } from './backends'
import type { BackendConfig } from './settings'

export type BackendSectionId = 'provider' | 'cli'

export interface BackendFieldPlan {
  command: boolean
  baseUrl: boolean
  apiKey: boolean
  /** CLI rows that can store a key, but sign in through the terminal first. */
  apiKeyOptional: boolean
}

/**
 * Grok is the only agent CLI that reads a Settings API key (`XAI_API_KEY`).
 * A stored key on any other CLI — OpenCode's local server password — stays
 * editable so it can be replaced or cleared, and is hidden while empty.
 */
const CLI_KEY_IDS = new Set(['grok'])

/** A cloud row is listed only after the user adds it, or when a key is already saved. */
export function providerIsListed(
  config: Pick<BackendConfig, 'added' | 'hasApiKey' | 'apiKey'> | undefined
): boolean {
  if (!config) return false
  if (config.added === true) return true
  if (config.hasApiKey === true) return true
  return typeof config.apiKey === 'string' && config.apiKey.trim() !== ''
}

export function listedBackends<T extends { id: string; kind: BackendKind }>(
  backends: readonly T[],
  configs: Record<string, Pick<BackendConfig, 'added' | 'hasApiKey' | 'apiKey'> | undefined> | undefined,
  keepId?: string
): T[] {
  return backends.filter((backend) => {
    if (backend.kind === 'agent-cli') return true
    if (keepId && backend.id === keepId) return true
    return providerIsListed(configs?.[backend.id])
  })
}

export function backendSection(kind: BackendKind): BackendSectionId {
  return kind === 'agent-cli' ? 'cli' : 'provider'
}

export function cliShowsApiKey(id: string, hasApiKey: boolean): boolean {
  return CLI_KEY_IDS.has(id) || hasApiKey
}

export function backendFieldPlan(backend: { id: string; kind: BackendKind }, hasApiKey: boolean): BackendFieldPlan {
  if (backend.kind === 'agent-cli') {
    const apiKey = cliShowsApiKey(backend.id, hasApiKey)
    return { command: true, baseUrl: false, apiKey, apiKeyOptional: apiKey }
  }
  return { command: false, baseUrl: true, apiKey: true, apiKeyOptional: false }
}

/** Providers first: their keys have to be visible without scrolling past the CLIs. */
export function orderedBackendSections<T extends { kind: BackendKind }>(
  backends: readonly T[]
): Array<{ id: BackendSectionId; items: T[] }> {
  const providers: T[] = []
  const clis: T[] = []
  for (const backend of backends) {
    if (backendSection(backend.kind) === 'cli') clis.push(backend)
    else providers.push(backend)
  }
  return [
    { id: 'provider', items: providers },
    { id: 'cli', items: clis }
  ]
}
