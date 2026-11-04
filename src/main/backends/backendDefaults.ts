/**
 * Default configuration per backend: generic localhost endpoints for local
 * servers, official API hosts for cloud providers, nothing machine-specific.
 */

import { PROVIDER_CATALOG } from '../../shared/providerCatalog'
import { AGENT_CLI_SPECS } from './cli'
import type { BackendConfig } from './types'

/**
 * Only the direct-API adapters need a base URL. Agent CLIs are located by
 * binary, not by endpoint.
 */
export const DEFAULT_BASE_URLS: Record<string, string> = Object.fromEntries(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider.baseUrl])
)

/** Seed for `Settings.backends`. */
export function defaultBackendConfigs(): Record<string, BackendConfig> {
  const configs: Record<string, BackendConfig> = {}
  for (const [id, baseUrl] of Object.entries(DEFAULT_BASE_URLS)) {
    configs[id] = { enabled: true, baseUrl }
  }
  for (const spec of AGENT_CLI_SPECS) {
    configs[spec.id] = {
      enabled: true,
      ...(spec.defaultBinaryPath ? { command: spec.defaultBinaryPath } : {})
    }
  }
  return configs
}

/** Merge stored settings over the defaults for one backend. */
export function configFor(
  id: string,
  configs: Record<string, BackendConfig> | undefined
): BackendConfig {
  const defaults = defaultBackendConfigs()[id] ?? { enabled: true }
  const stored = configs?.[id]
  return stored ? { ...defaults, ...stored } : defaults
}
