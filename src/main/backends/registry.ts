/**
 * The backend registry: every adapter, one detection pass, one lookup.
 *
 * `detectAll` never throws and never blocks startup — each backend gets a hard
 * time budget, results are cached to disk, and `cachedBackendInfos` renders the
 * last-known state instantly while a fresh pass runs.
 */

import { PROVIDER_CATALOG } from '../../shared/providerCatalog'
import type { BackendInfo } from '../../shared/types'
import { anthropicBackend, anthropicCompatibleBackend } from './anthropic'
import { getSettings } from '../settings'
import { isCustomBackendId } from '../settingsSchema'
import { configFor } from './backendDefaults'
import { agentCliBackends } from './cli'
import { raceTimeout } from './httpClient'
import { errorMessage } from './httpErrors'
import { resetHydratedEnv } from './loginShellEnv'
import { openaiBackend } from './openai'
import { openAiCompatibleBackend } from './openaiCompatible'
import { openrouterBackend } from './openrouter'
import { readStatusCache, rememberStatuses } from './statusCache'
import type { Backend, BackendConfig, ModelInfo } from './types'
import { UNCHECKED_BACKEND_DETAIL } from '../../shared/backendPrompt'
import { clearWhichCache } from './which'
import { xaiBackend } from './xai'

/** Hard ceiling per backend, covering detection plus its model listing. */
const BACKEND_BUDGET_MS = 8000
const CODEX_BUDGET_MS = 24_000

/**
 * Agent CLIs first: they are the primary path, run locally, and bring their own
 * auth. The direct cloud adapters are the fallback for users with a bare API
 * key and no CLI installed.
 */
const DEDICATED_PROVIDER_IDS = new Set(['openai', 'anthropic', 'xai', 'openrouter'])

export const BACKENDS: Backend[] = [
  ...agentCliBackends,
  openaiBackend,
  anthropicBackend,
  xaiBackend,
  openrouterBackend,
  ...PROVIDER_CATALOG.filter((entry) => entry.protocol === 'openai' && !DEDICATED_PROVIDER_IDS.has(entry.id)).map(
    (entry) => openAiCompatibleBackend(entry)
  )
]

const BY_ID = new Map(BACKENDS.map((b) => [b.id, b]))

function configuredBackends(configs: Record<string, BackendConfig>): Backend[] {
  return Object.entries(configs).flatMap(([id, cfg]) => {
    if (!isCustomBackendId(id) || cfg.added === false || !cfg.providerName || !cfg.providerProtocol || !cfg.baseUrl) return []
    return [cfg.providerProtocol === 'anthropic'
      ? anthropicCompatibleBackend(id, cfg.providerName)
      : openAiCompatibleBackend({ id, label: cfg.providerName, protocol: 'openai', baseUrl: cfg.baseUrl, keyHint: '', keywords: '' })]
  })
}

export function listBackends(): Backend[] {
  return [...BACKENDS, ...configuredBackends(getSettings().backends)]
}

export function getBackend(id: string): Backend | undefined {
  return BY_ID.get(id) ?? configuredBackends(getSettings().backends).find((backend) => backend.id === id)
}

function toolModeFor(backend: Backend, models: ModelInfo[]): 'native' | 'prompted' {
  if (backend.kind !== 'local-server') return 'native'
  if (!models.length) return 'prompted'
  return models.some((m) => m.supportsTools) ? 'native' : 'prompted'
}

function shell(backend: Backend): BackendInfo {
  return {
    id: backend.id,
    label: backend.label,
    kind: backend.kind,
    status: 'error',
    models: [],
    local: backend.local,
    ...(backend.supportsVmOrchestration ? { supportsVmOrchestration: true } : {}),
    toolMode: backend.kind === 'local-server' ? 'prompted' : 'native'
  }
}

async function detectOne(backend: Backend, cfg: BackendConfig): Promise<BackendInfo> {
  const base = shell(backend)
  if (cfg.enabled === false) {
    return { ...base, status: 'not-installed', statusDetail: 'Disabled in Settings.' }
  }

  try {
    /*
     * Codex's model list is another app-server start. Running it beside
     * detection keeps both inside the same time budget; every other backend
     * still lists only after it is actually available.
     */
    const earlyModels =
      backend.id === 'codex' ? backend.listModels(cfg).catch(() => [] as ModelInfo[]) : null
    const result = await backend.detect(cfg)
    let models =
      result.status === 'available'
        ? await (earlyModels ?? backend.listModels(cfg).catch(() => [] as ModelInfo[]))
        : []
    let modelNote = ''
    if (backend.id === 'codex' && result.status === 'available' && !models.some((model) => model.id !== 'default')) {
      const previous = (await readStatusCache())[backend.id]?.models ?? []
      modelNote = ' Model discovery returned no choices; check the connection and retry.'
      if (previous.some((model) => model.id !== 'default')) {
        models = previous
        modelNote = ' Model discovery returned no choices; showing the previously detected list.'
      }
    }
    return {
      ...base,
      status: result.status,
      ...(result.detail || modelNote ? { statusDetail: `${result.detail ?? ''}${modelNote}`.trim() } : {}),
      ...(result.cliAuth ? { cliAuth: result.cliAuth } : {}),
      models,
      toolMode: toolModeFor(backend, models)
    }
  } catch (err) {
    // Detection is best-effort by contract: report, never throw.
    return { ...base, status: 'error', statusDetail: errorMessage(err) }
  }
}

/** Probe every backend in parallel. Resolves in bounded time, always. */
export async function detectAll(
  configs?: Record<string, BackendConfig>
): Promise<BackendInfo[]> {
  const infos = await Promise.all(
    [...BACKENDS, ...configuredBackends(configs ?? getSettings().backends)].map((backend) =>
      raceTimeout(detectOne(backend, configFor(backend.id, configs)), backend.id === 'codex' ? CODEX_BUDGET_MS : BACKEND_BUDGET_MS, {
        ...shell(backend),
        status: 'error' as const,
        statusDetail: 'Detection timed out.'
      })
    )
  )
  await rememberStatuses(infos)
  return infos
}

function provisionalStatus(backend: Backend): BackendInfo {
  const base = shell(backend)
  const status =
    backend.kind === 'cloud-api'
      ? ('needs-key' as const)
      : backend.kind === 'agent-cli'
        ? ('not-installed' as const)
        : ('not-running' as const)
  return { ...base, status, statusDetail: UNCHECKED_BACKEND_DETAIL }
}

/**
 * Last-known state from disk, for an instant first paint.
 * Call `detectAll` right after and replace the list when it resolves.
 */
export async function cachedBackendInfos(): Promise<BackendInfo[]> {
  const cache = await readStatusCache()
  return listBackends().map((backend) => {
    const stored = cache[backend.id]
    if (!stored) return provisionalStatus(backend)
    return {
      ...shell(backend),
      status: stored.status,
      ...(stored.statusDetail ? { statusDetail: stored.statusDetail } : {}),
      models: stored.models ?? [],
      toolMode: stored.toolMode ?? 'native',
      ...(stored.supportsVmOrchestration ? { supportsVmOrchestration: true } : {}),
      ...(stored.cliAuth ? { cliAuth: stored.cliAuth } : {})
    }
  })
}

/** Drop memoised PATH/env lookups so a manual refresh really re-probes. */
export function invalidateDetection(): void {
  clearWhichCache()
  resetHydratedEnv()
}

/** Re-probe one backend and return its fresh row. */
export async function redetectOne(
  id: string,
  configs?: Record<string, BackendConfig>
): Promise<BackendInfo | null> {
  const backend = BY_ID.get(id) ?? configuredBackends(configs ?? getSettings().backends).find((entry) => entry.id === id)
  if (!backend) return null
  invalidateDetection()
  const info = await raceTimeout(detectOne(backend, configFor(backend.id, configs)), backend.id === 'codex' ? CODEX_BUDGET_MS : BACKEND_BUDGET_MS, {
    ...shell(backend),
    status: 'error' as const,
    statusDetail: 'Detection timed out.'
  })
  await rememberStatuses([info])
  return info
}
