/**
 * Settings defaults, deep-merge and coercion.
 *
 * Stored settings are always merged *over* the defaults, so a key added in a
 * later version simply appears with its default value instead of breaking an
 * existing install. Unknown keys are dropped and every value is enum/range
 * checked — the renderer is never trusted.
 */

import type {
  AgentMode,
  ApprovalPolicy,
  BackendConfig,
  McpServerConfig,
  Settings
} from '../shared/types'

const THEMES: ReadonlyArray<Settings['theme']> = ['system', 'light', 'dark']
const MODES: ReadonlyArray<AgentMode> = ['agent', 'ask', 'plan']
/**
 * Where a memory-extraction side call may run. `api` keeps it on direct HTTP
 * backends: an agent-CLI extraction spawns a second billable CLI process after
 * every turn, which is rarely what someone wants by default.
 */
const MEMORY_EXTRACTION = ['off', 'api', 'all'] as const

const POLICIES: ReadonlyArray<ApprovalPolicy> = [
  'ask-every-time',
  'ask-first-time',
  'allowlist',
  'auto-run'
]

const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24

/**
 * Backends OpenBOT knows how to look for. Detection lives in the registry;
 * this is only the persisted per-backend configuration. Local and cloud are
 * peers — identical interface, identical tool support.
 */
function defaultBackends(): Record<string, BackendConfig> {
  return {
    // Agent CLIs — located by binary, not by endpoint.
    opencode: { enabled: true, command: 'opencode', extraArgs: [] },
    claude: { enabled: true, command: 'claude', extraArgs: [] },
    codex: { enabled: true, command: 'codex', extraArgs: [] },
    kimi: { enabled: true, command: 'kimi', extraArgs: [] },
    grok: { enabled: true, command: 'grok', extraArgs: [] },
    pi: { enabled: true, command: 'pi', extraArgs: [] },
    droid: { enabled: true, command: 'droid', extraArgs: [] },
    // Direct API — the fallback for a bare key with no CLI installed.
    anthropic: { enabled: true, baseUrl: 'https://api.anthropic.com', apiKey: '' },
    openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: '' },
    xai: { enabled: true, baseUrl: 'https://api.x.ai/v1', apiKey: '' },
    openrouter: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' }
  }
}

/**
 * Every backend id this build understands. Anything else in a stored settings
 * file predates a rename or removal and is retired on load — see `migrate`.
 */
export const KNOWN_BACKEND_IDS: readonly string[] = Object.keys(defaultBackends())

/** `default` means "whatever the agent is configured to use". */
export const DEFAULT_MODEL_ID = 'default'
export const DEFAULT_BACKEND_ID = 'opencode'

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    fontSize: 14,
    defaultBackendId: DEFAULT_BACKEND_ID,
    defaultModelId: DEFAULT_MODEL_ID,
    defaultMode: 'agent',
    approvalPolicy: 'ask-every-time',
    allowlist: [],
    denylist: [],
    memoryExtraction: 'api',
    runInBackground: false,
    rules: '',
    backends: defaultBackends(),
    mcpServers: [],
    computerUseAllowedApps: [],
    telemetry: false
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keys that reach the prototype chain rather than the object. `JSON.parse`
 * keeps `__proto__` as a real own property, so a crafted settings file or a
 * patch from the renderer can carry one straight into a hand-rolled merge.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Recursive merge of `patch` over `base`. Arrays are replaced wholesale (an
 * empty allowlist must be able to clear a populated one), `undefined` values in
 * the patch are ignored, and prototype-reaching keys are dropped.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out as T
}

function pickEnum<T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T {
  return typeof value === 'string' && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function normaliseBackends(
  value: unknown,
  fallback: Record<string, BackendConfig>
): Record<string, BackendConfig> {
  const out: Record<string, BackendConfig> = { ...fallback }
  if (!isPlainObject(value)) return out
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw) || UNSAFE_KEYS.has(id)) continue
    const base = out[id] ?? { enabled: true }
    const config: BackendConfig = {
      enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : base.enabled
    }
    const baseUrl = raw['baseUrl'] ?? base.baseUrl
    const apiKey = raw['apiKey'] ?? base.apiKey
    const command = raw['command'] ?? base.command
    const extraArgs = raw['extraArgs'] ?? base.extraArgs
    if (typeof baseUrl === 'string') config.baseUrl = baseUrl
    if (typeof apiKey === 'string') config.apiKey = apiKey
    if (raw['hasApiKey'] === true || base.hasApiKey === true) config.hasApiKey = true
    if (typeof command === 'string') config.command = command
    if (Array.isArray(extraArgs)) config.extraArgs = stringList(extraArgs)
    out[id] = config
  }
  return out
}

function normaliseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return []
  const out: McpServerConfig[] = []
  for (const raw of value) {
    if (!isPlainObject(raw)) continue
    const id = typeof raw['id'] === 'string' ? raw['id'] : ''
    if (!id) continue
    const server: McpServerConfig = {
      id,
      name: typeof raw['name'] === 'string' ? raw['name'] : id,
      enabled: raw['enabled'] !== false,
      transport: raw['transport'] === 'http' ? 'http' : 'stdio'
    }
    if (typeof raw['command'] === 'string') server.command = raw['command']
    if (Array.isArray(raw['args'])) server.args = stringList(raw['args'])
    if (typeof raw['url'] === 'string') server.url = raw['url']
    if (typeof raw['provider'] === 'string') server.provider = raw['provider'].slice(0, 100)
    if (typeof raw['accountName'] === 'string') server.accountName = raw['accountName'].slice(0, 200)
    if (raw['auth'] === 'oauth' || raw['auth'] === 'bearer' || raw['auth'] === 'none') server.auth = raw['auth']
    if (typeof raw['bearerToken'] === 'string') server.bearerToken = raw['bearerToken']
    if (raw['hasBearerToken'] === true) server.hasBearerToken = true
    if (Array.isArray(raw['disabledTools'])) server.disabledTools = stringList(raw['disabledTools'])
    if (isPlainObject(raw['env'])) {
      const env: Record<string, string> = {}
      for (const [key, entry] of Object.entries(raw['env'])) {
        if (typeof entry === 'string' && !UNSAFE_KEYS.has(key)) env[key] = entry
      }
      server.env = env
    }
    out.push(server)
  }
  return out
}

/**
 * Retire config for backends this build no longer knows about.
 *
 * Stored settings are merged *over* the defaults, so an id that has been
 * renamed or removed would otherwise survive forever — and a stale
 * `defaultBackendId` leaves the app pointed at a backend that resolves to
 * nothing, with no model preselected and no visible reason why.
 */
function retireUnknownBackends(
  backends: Record<string, BackendConfig>
): Record<string, BackendConfig> {
  const kept: Record<string, BackendConfig> = {}
  for (const [id, config] of Object.entries(backends)) {
    if (KNOWN_BACKEND_IDS.includes(id)) kept[id] = config
  }
  return kept
}

/** Coerce anything into a valid `Settings`, filling gaps from the defaults. */
export function normaliseSettings(raw: unknown): Settings {
  const defaults = defaultSettings()
  const merged = deepMerge<Record<string, unknown>>(
    defaults as unknown as Record<string, unknown>,
    isPlainObject(raw) ? raw : {}
  )
  const fontSize = Number(merged['fontSize'])

  const storedBackendId = merged['defaultBackendId']
  const backendId =
    typeof storedBackendId === 'string' && KNOWN_BACKEND_IDS.includes(storedBackendId)
      ? storedBackendId
      : defaults.defaultBackendId
  // A model slug only means something next to its backend, so reset both together.
  const storedModelId = merged['defaultModelId']
  const modelId =
    backendId === storedBackendId && typeof storedModelId === 'string' && storedModelId
      ? storedModelId
      : defaults.defaultModelId

  return {
    theme: pickEnum(merged['theme'], THEMES, defaults.theme),
    fontSize: Number.isFinite(fontSize)
      ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(fontSize)))
      : defaults.fontSize,
    defaultBackendId: backendId,
    defaultModelId: modelId,
    defaultMode: pickEnum(merged['defaultMode'], MODES, defaults.defaultMode),
    approvalPolicy: pickEnum(merged['approvalPolicy'], POLICIES, defaults.approvalPolicy),
    allowlist: stringList(merged['allowlist']),
    denylist: stringList(merged['denylist']),
    memoryExtraction: pickEnum(merged['memoryExtraction'], MEMORY_EXTRACTION, defaults.memoryExtraction ?? 'api'),
    runInBackground: merged['runInBackground'] === true,
    rules: typeof merged['rules'] === 'string' ? merged['rules'] : defaults.rules,
    backends: retireUnknownBackends(normaliseBackends(merged['backends'], defaults.backends)),
    mcpServers: normaliseMcpServers(merged['mcpServers']),
    computerUseAllowedApps: stringList(merged['computerUseAllowedApps']),
    // OpenBOT never phones home. Not user-configurable, by design.
    telemetry: false
  }
}
