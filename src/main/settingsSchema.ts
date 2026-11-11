/**
 * Settings defaults, deep-merge and coercion.
 *
 * Stored settings are always merged *over* the defaults, so a key added in a
 * later version simply appears with its default value instead of breaking an
 * existing install. Unknown keys are dropped and every value is enum/range
 * checked — the renderer is never trusted.
 */

import type { AppId, AppLinks } from '../shared/apps'
import { CLI_CATALOG } from '../shared/cliCatalog'
import { normaliseLocalCliAgentsMd } from '../shared/localCliTools'
import { PROVIDER_CATALOG } from '../shared/providerCatalog'
import { isThinkingDepth } from '../shared/thinking'
import { profileImageSource } from '../shared/userProfile'
import { localExecutionPolicy } from '../shared/localExecution'
import type {
  AccentColor,
  AgentMode,
  ApprovalPolicy,
  BackendConfig,
  LinkOpen,
  McpServerConfig,
  SendShortcut,
  Settings,
  UiLanguage,
  UiScale,
  UpdateChannel
} from '../shared/types'

const THEMES: ReadonlyArray<Settings['theme']> = ['system', 'light', 'dark']
const LANGUAGES: ReadonlyArray<UiLanguage> = ['system', 'en', 'zh-CN']
const SHORTCUTS: ReadonlyArray<SendShortcut> = ['enter', 'mod-enter']
const LINK_OPENS: ReadonlyArray<LinkOpen> = ['browser', 'window']
const ACCENTS: ReadonlyArray<AccentColor> = ['theme', 'amber', 'blue', 'purple', 'pink', 'green', 'slate', 'orange', 'red']
const CHANNELS: ReadonlyArray<UpdateChannel> = ['stable', 'beta']
export const UI_SCALES: readonly UiScale[] = [80, 90, 100, 110, 125, 150]

function normaliseQuickDecision(raw: unknown): Settings['quickDecision'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.backendId !== 'string' || !value.backendId.trim() || value.backendId.length > 200 ||
      typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId.length > 300) return null
  return { backendId: value.backendId.trim(), modelId: value.modelId.trim() }
}
const MODES: ReadonlyArray<AgentMode> = ['agent', 'ask', 'plan']
/** Explicit saved extraction choices are retained; new installs use the product default. */
const MEMORY_EXTRACTION: ReadonlyArray<NonNullable<Settings['memoryExtraction']>> = ['off', 'api', 'all']

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
const APP_IDS: readonly AppId[] = ['github', 'git', 'gmail', 'calendar', 'slack', 'x']

function defaultApps(): AppLinks {
  return { github: {}, git: {}, gmail: {}, calendar: {}, slack: {}, x: {} }
}

function defaultBackends(): Record<string, BackendConfig> {
  const configs: Record<string, BackendConfig> = {}
  for (const cli of CLI_CATALOG) {
    configs[cli.id] = { enabled: true, command: cli.command, extraArgs: [] }
  }
  for (const provider of PROVIDER_CATALOG) {
    configs[provider.id] = { enabled: true, added: false, baseUrl: provider.baseUrl, apiKey: '' }
  }
  return configs
}

/**
 * Every backend id this build understands. Anything else in a stored settings
 * file predates a rename or removal and is retired on load — see `migrate`.
 */
export const KNOWN_BACKEND_IDS: readonly string[] = Object.keys(defaultBackends())

export function isCustomBackendId(id: string): boolean {
  return /^custom-[a-z0-9-]{1,64}$/.test(id)
}

/** `default` means "whatever the agent is configured to use". */
export const DEFAULT_MODEL_ID = 'default'
export const DEFAULT_BACKEND_ID = 'opencode'

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    fontSize: 14,
    uiScale: 100,
    vibrant: false,
    nativeGlass: true,
    language: 'zh-CN',
    accent: 'theme',
    sendShortcut: 'enter',
    expandSteps: false,
    linkOpen: 'browser',
    launchAtLogin: false,
    runRoutinesWhenClosed: true,
    profileName: '',
    profileImage: '',
    profileEmoji: '🙂',
    profileColor: '#7c9cff',
    notifications: true,
    notifyOnTurn: false,
    voiceLanguage: 'system',
    decisionSkillReview: false,
    updateChannel: 'stable',
    defaultBackendId: DEFAULT_BACKEND_ID,
    defaultModelId: DEFAULT_MODEL_ID,
    defaultMode: 'agent',
    approvalPolicy: 'auto-run',
    allowlist: [],
    asklist: [],
    semanticPermissionRules: [],
    automaticReview: true,
    denylist: [],
    memoryExtraction: 'all',
    runInBackground: false,
    rules: '',
    backends: defaultBackends(),
    mcpServers: [],
    localCliAgentsMd: {},
    apps: defaultApps(),
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
    if (typeof raw['providerName'] === 'string') config.providerName = raw['providerName'].trim().slice(0, 80)
    if (raw['providerProtocol'] === 'openai' || raw['providerProtocol'] === 'anthropic') config.providerProtocol = raw['providerProtocol']
    if (typeof raw['credentialOrigin'] === 'string') config.credentialOrigin = raw['credentialOrigin']
    if (typeof apiKey === 'string') config.apiKey = apiKey
    const hasSecret =
      (typeof apiKey === 'string' && apiKey.trim() !== '') ||
      raw['hasApiKey'] === true ||
      base.hasApiKey === true
    if (hasSecret) config.hasApiKey = true
    if (typeof command === 'string') config.command = command
    if (Array.isArray(extraArgs)) config.extraArgs = stringList(extraArgs)
    // A saved key means the provider was already in use. An explicit `added`
    // flag wins, including `false` after the user removes the row.
    if (typeof raw['added'] === 'boolean') config.added = raw['added']
    else if (hasSecret) config.added = true
    else if (typeof base.added === 'boolean') config.added = base.added
    const defaultModelId = raw['defaultModelId'] ?? base.defaultModelId
    if (typeof defaultModelId === 'string' && /^[A-Za-z0-9._:@/-]{1,120}$/.test(defaultModelId)) {
      config.defaultModelId = defaultModelId
    }
    const modelThinking = raw['modelThinking'] ?? base.modelThinking
    if (isPlainObject(modelThinking)) {
      config.modelThinking = Object.fromEntries(Object.entries(modelThinking).filter(([model, depth]) => /^[A-Za-z0-9._:@/-]{1,120}$/.test(model) && !UNSAFE_KEYS.has(model) && isThinkingDepth(depth))) as BackendConfig['modelThinking']
    }
    out[id] = config
  }
  return out
}

function normaliseApps(value: unknown): AppLinks {
  const out = defaultApps()
  if (!isPlainObject(value)) return out
  for (const id of APP_IDS) {
    const raw = value[id]
    if (isPlainObject(raw) && raw['pending'] === true) out[id] = { pending: true }
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
    if (KNOWN_BACKEND_IDS.includes(id) || (isCustomBackendId(id) && config.providerName && config.providerProtocol && config.baseUrl)) kept[id] = config
  }
  return kept
}

/** Coerce anything into a valid `Settings`, filling gaps from the defaults. */
function pickScale(value: unknown): UiScale {
  const n = Number(value)
  return UI_SCALES.includes(n as UiScale) ? (n as UiScale) : 100
}

function shortText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : fallback
}

export function normaliseSettings(raw: unknown): Settings {
  const defaults = defaultSettings()
  const rawObj = isPlainObject(raw) ? raw : {}
  // Older files used one switch for "start at login" and "keep running".
  // Keep that login behavior until the user sets the new field themselves.
  const hadLaunchAtLogin = Object.prototype.hasOwnProperty.call(rawObj, 'launchAtLogin')
  const merged = deepMerge<Record<string, unknown>>(
    defaults as unknown as Record<string, unknown>,
    rawObj
  )
  const fontSize = Number(merged['fontSize'])

  const storedBackendId = merged['defaultBackendId']
  const backendId =
    typeof storedBackendId === 'string' && (KNOWN_BACKEND_IDS.includes(storedBackendId) || (isCustomBackendId(storedBackendId) && isPlainObject(rawObj['backends']) && isPlainObject(rawObj['backends'][storedBackendId])))
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
    uiScale: pickScale(merged['uiScale']),
    vibrant: false,
    nativeGlass: merged['nativeGlass'] !== false,
    language: pickEnum(merged['language'], LANGUAGES, defaults.language),
    accent: pickEnum(merged['accent'], ACCENTS, defaults.accent),
    sendShortcut: pickEnum(merged['sendShortcut'], SHORTCUTS, defaults.sendShortcut),
    expandSteps: merged['expandSteps'] === true,
    linkOpen: pickEnum(merged['linkOpen'], LINK_OPENS, defaults.linkOpen),
    launchAtLogin: hadLaunchAtLogin ? merged['launchAtLogin'] === true : merged['runInBackground'] === true,
    runRoutinesWhenClosed: merged['runRoutinesWhenClosed'] !== false,
    profileName: typeof merged['profileName'] === 'string' ? merged['profileName'].trim().slice(0, 80) : '',
    profileImage: profileImageSource(merged['profileImage']) ?? '',
    profileEmoji: shortText(merged['profileEmoji'], 8, defaults.profileEmoji),
    profileColor: /^#[0-9a-fA-F]{6}$/.test(String(merged['profileColor'] ?? ''))
      ? String(merged['profileColor'])
      : defaults.profileColor,
    notifications: merged['notifications'] !== false,
    notifyOnTurn: merged['notifyOnTurn'] === true,
    voiceLanguage: typeof merged['voiceLanguage'] === 'string' && /^(system|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})$/.test(merged['voiceLanguage']) ? merged['voiceLanguage'] : 'system',
    decisionSkillReview: merged['decisionSkillReview'] === true,
    updateChannel: pickEnum(merged['updateChannel'], CHANNELS, defaults.updateChannel),
    defaultBackendId: backendId,
    defaultModelId: modelId,
    ...(isThinkingDepth(merged['defaultThinking']) ? { defaultThinking: merged['defaultThinking'] } : {}),
    defaultMode: pickEnum(merged['defaultMode'], MODES, defaults.defaultMode),
    approvalPolicy: pickEnum(merged['approvalPolicy'], POLICIES, defaults.approvalPolicy),
    localExecutionPolicy: localExecutionPolicy({
      localExecutionPolicy: merged['localExecutionPolicy'] as Settings['localExecutionPolicy'],
      approvalPolicy: pickEnum(merged['approvalPolicy'], POLICIES, defaults.approvalPolicy)
    }),
    automaticReview: typeof merged['automaticReview'] === 'boolean' ? merged['automaticReview'] : true,
    asklist: stringList(merged['asklist']),
    // Preserve unknown/corrupt rule records too. The reviewer fails closed;
    // dropping an unrecognised ask rule could silently broaden authorization.
    semanticPermissionRules: (merged['semanticPermissionRules'] ?? []) as Settings['semanticPermissionRules'],
    allowlist: stringList(merged['allowlist']),
    denylist: stringList(merged['denylist']),
    memoryExtraction: pickEnum(merged['memoryExtraction'], MEMORY_EXTRACTION, defaults.memoryExtraction ?? 'all'),
    runInBackground: merged['runInBackground'] === true,
    rules: typeof merged['rules'] === 'string' ? merged['rules'] : defaults.rules,
    quickDecision: normaliseQuickDecision(merged['quickDecision']),
    // Use the file's own backend map, not the deep-merged one. Defaults set
    // `added: false`, and merging them in first would hide a saved key that
    // never had the flag.
    backends: retireUnknownBackends(
      normaliseBackends(
        Object.prototype.hasOwnProperty.call(rawObj, 'backends') ? rawObj['backends'] : defaults.backends,
        defaults.backends
      )
    ),
    mcpServers: normaliseMcpServers(merged['mcpServers']),
    localCliAgentsMd: normaliseLocalCliAgentsMd(merged['localCliAgentsMd']),
    apps: normaliseApps(Object.prototype.hasOwnProperty.call(rawObj, 'apps') ? rawObj['apps'] : defaults.apps),
    computerUseAllowedApps: stringList(merged['computerUseAllowedApps']),
    // OpenBOT never phones home. Not user-configurable, by design.
    telemetry: false
  }
}
