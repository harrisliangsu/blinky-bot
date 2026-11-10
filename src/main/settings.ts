/**
 * Settings lifecycle: load once at startup, keep in memory, persist changes.
 * Shape, defaults and merging live in `settingsSchema.ts`.
 */

import type { Settings } from '../shared/types'
import type { UserProfilePatch } from '../shared/settings'
import type { McpServerEdit, PermissionEdit } from '../shared/settings'
import { isSemanticPermissionRule } from '../shared/permissionRules'
import { noteLocalPermissionSettings } from './localExecution'
import { canonicalProfileImage } from './profileImage'
import {
  defaultSettings,
  deepMerge,
  isPlainObject,
  isCustomBackendId,
  KNOWN_BACKEND_IDS,
  normaliseSettings
} from './settingsSchema'
import { readJsonState, writeJsonDebounced, writeJsonNow } from './store/jsonStore'
import { settingsFile } from './store/paths'
import {
  backendApiKey,
  clearBackendApiKey,
  hasBackendApiKey,
  setBackendApiKey
} from './store/backendSecrets'
import { clearMcpBearerToken, flushMcpSecrets, hasMcpBearerToken, mcpBearerToken, setMcpBearerToken, stageMcpBearerToken } from './store/mcpSecrets'
import { originOf } from './backends/keyHost'
import { listBots } from './store/bots'
import { interruptDecisionReviews } from './agent/decisionReviewLifecycle'

let current: Settings = defaultSettings()
let reviewPreference = false
let loading: Promise<Settings> | null = null

/** Load `settings.json` from disk. Safe to call more than once. */
export function initSettings(): Promise<Settings> {
  if (!loading) loading = read()
  return loading
}

async function read(): Promise<Settings> {
  const file = settingsFile()
  const { status, value } = await readJsonState<unknown>(file, null)
  current = normaliseSettings(value)
  reviewPreference = current.decisionSkillReview === true
  /**
   * A credential that could not be encrypted is still stripped from the file.
   *
   * This used to latch a flag that SKIPPED the rewrite below — the one write
   * that removes the plaintext `apiKey`/`bearerToken` from `settings.json` — so
   * a machine with no working OS credential store kept the secret sitting in a
   * world-readable JSON file indefinitely, and every later `updateSettings`
   * declined to persist too. Removing it from disk is the safer half of the
   * trade: the key stays usable in memory for this session, and the warning
   * says plainly that it has to be re-entered.
   */
  let secretMigrationFailed = false
  for (const [id, config] of Object.entries(current.backends)) {
    const legacy = config.apiKey?.trim()
    if (legacy) {
      try {
        setBackendApiKey(id, legacy)
      } catch (error) {
        secretMigrationFailed = true
        console.warn(
          '[openbot/settings] could not encrypt the plaintext API key for',
          id,
          '— it has been removed from settings.json and must be re-entered in Settings',
          error
        )
      }
    }
    const stored = backendApiKey(id)
    if (stored) config.apiKey = stored
    config.hasApiKey = Boolean(stored || legacy)
  }
  for (const server of current.mcpServers) {
    const legacy = server.bearerToken?.trim()
    if (legacy) {
      try {
        setMcpBearerToken(server.id, legacy)
      } catch (error) {
        secretMigrationFailed = true
        console.warn(
          '[openbot/settings] could not encrypt the plaintext MCP token for',
          server.id,
          '— it has been removed from settings.json and must be re-entered in Settings',
          error
        )
      }
    }
    // `?? legacy` so a failed migration does not also cut the session off from
    // a credential it already holds; only the on-disk copy goes.
    server.bearerToken = mcpBearerToken(server.id) ?? legacy
    server.hasBearerToken = hasMcpBearerToken(server.id) || Boolean(legacy)
  }
  // A file we could not open still holds the user's real config. Writing the
  // defaults over it — which is what "persist the normalised shape" would do
  // here — would destroy it, so this launch runs on defaults and leaves the
  // file alone. A missing, empty or quarantined file is safe to replace.
  if (status === 'unreadable') {
    console.warn('[openbot/settings] settings.json is unreadable; running on defaults')
    // Latched, because refusing to overwrite *here* only deferred the damage by
    // one write: the next `updateSettings` — a theme toggle is enough — wrote
    // the defaults straight over the intact file. The directory is still
    // writable, so nothing else stops it. API keys, allowlist and denylist all
    // went with it, which is a safety regression as well as data loss.
    unreadable = true
    return current
  }
  unreadable = false
  // Persist the normalised shape so the file always reflects the live schema,
  // but only when that actually changes something. A write that fails now says
  // so instead of resolving quietly, and it must not take startup down with it:
  // the settings in memory are valid either way.
  // `secretMigrationFailed` forces the write rather than suppressing it: that
  // is the pass that takes the plaintext credential off disk.
  const persisted = persistedSettings(current)
  if (
    secretMigrationFailed ||
    status !== 'ok' ||
    JSON.stringify(value) !== JSON.stringify(persisted)
  ) {
    try {
      await writeJsonNow(file, persisted)
    } catch (err) {
      console.error('[openbot/settings] could not persist the normalised settings', err)
    }
  }
  return current
}

/** The in-memory settings. Always a complete, valid object. */
export function getSettings(): Settings {
  return current
}

/** Set when the file could not be read: nothing may be persisted over it. */
let unreadable = false

/** Whether this launch is running on defaults because the file is unreadable. */
export function settingsAreUnreadable(): boolean {
  return unreadable
}

/** Deep-merge a partial update, persist it, and return the new settings. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = deepMerge<Record<string, unknown>>(
    current as unknown as Record<string, unknown>,
    isPlainObject(patch) ? (patch as Record<string, unknown>) : {}
  )
  current = normaliseSettings(merged)
  if (unreadable) {
    console.warn('[openbot/settings] not persisting over an unreadable settings.json')
    return current
  }
  writeJsonDebounced(settingsFile(), persistedSettings(current))
  announce(current)
  return current
}

let voiceWrite: Promise<unknown> = Promise.resolve()
let decisionReviewWrite: Promise<unknown> = Promise.resolve()
export function saveDecisionSkillReview(enabled: unknown): Promise<Settings> {
  const run = decisionReviewWrite.catch(() => undefined).then(async () => {
    if (unreadable || typeof enabled !== 'boolean') throw new Error('Invalid decision review preference')
    for (;;) {
      const before = current, next = normaliseSettings({ ...before, decisionSkillReview: enabled })
      await writeJsonNow(settingsFile(), persistedSettings(next))
      if (current !== before) continue
      current = next; announce(current); return next
    }
  })
  decisionReviewWrite = run.catch(() => undefined)
  return run
}
/** Publish this preference only after the atomic write, preserving concurrent edits. */
export function saveVoiceLanguage(language: unknown): Promise<string> {
  const run = voiceWrite.catch(() => undefined).then(async () => {
    if (unreadable || typeof language !== 'string' || normaliseSettings({ voiceLanguage: language }).voiceLanguage !== language) throw new Error('Invalid voice language')
    for (;;) {
      const before = current, next = normaliseSettings({ ...before, voiceLanguage: language })
      await writeJsonNow(settingsFile(), persistedSettings(next))
      if (current !== before) continue
      current = next; announce(current); return language
    }
  })
  voiceWrite = run.catch(() => undefined)
  return run
}

let profileWrite: Promise<unknown> = Promise.resolve()
let permissionWrite: Promise<unknown> = Promise.resolve()

/** Atomic list edits and durable permission changes; never replace a renderer snapshot. */
export function savePermissionEdit(edit: PermissionEdit): Promise<Settings> {
  const run = permissionWrite.catch(() => undefined).then(async () => {
    if (unreadable) throw new Error('Settings are unavailable')
    for (;;) {
      const before = current
      let patch: Partial<Settings>
      if (edit?.kind === 'options') {
        patch = {}
        if (Object.hasOwn(edit, 'localExecutionPolicy')) {
          if (!['always-allow', 'ask-every-time', 'never-allow'].includes(edit.localExecutionPolicy!)) throw new Error('Invalid local execution policy')
          patch.localExecutionPolicy = edit.localExecutionPolicy
        }
        if (Object.hasOwn(edit, 'automaticReview')) {
          if (typeof edit.automaticReview !== 'boolean') throw new Error('Invalid automatic review setting')
          patch.automaticReview = edit.automaticReview
        }
      } else if (edit?.kind === 'semantic-rule') {
        if (!isSemanticPermissionRule(edit.rule)) throw new Error('Invalid natural-language permission rule')
        const entries = before.semanticPermissionRules ?? []
        if (!Array.isArray(entries)) throw new Error('Saved rules need repair before editing')
        const old = entries.find(rule => rule.id === edit.rule.id)
        if (edit.previous ? JSON.stringify(old) !== JSON.stringify(edit.previous) : !!old) throw new Error('This rule changed. Reopen it to edit the current version.')
        const next = entries.filter(rule => rule.id !== edit.rule.id)
        if (!edit.remove) next.push({ ...edit.rule, text: edit.rule.text.trim() })
        patch = { semanticPermissionRules: next }
      } else if (edit?.kind === 'rule' && ['asklist', 'allowlist', 'denylist', 'computerUseAllowedApps'].includes(edit.list)) {
        if (typeof edit.value !== 'string' || !edit.value.trim() || edit.value.length > 2000) throw new Error('Enter a rule (maximum 2000 characters).')
        const value = edit.value.trim()
        const entries = before[edit.list] ?? []
        if (edit.previous !== undefined && !entries.includes(edit.previous)) throw new Error('This rule changed. Reopen it to edit the current version.')
        const next = entries.filter((item) => item !== (edit.previous ?? (edit.remove ? value : undefined)))
        if (!edit.remove && !next.includes(value)) next.push(value)
        patch = { [edit.list]: next }
      } else throw new Error('Invalid permission edit')
      const next = normaliseSettings({ ...before, ...patch })
      await writeJsonNow(settingsFile(), persistedSettings(next))
      if (current !== before) continue
      current = next
      announce(current)
      return current
    }
  })
  permissionWrite = run.catch(() => undefined)
  return run
}

let mcpWrite: Promise<unknown> = Promise.resolve()

/** Durable form save of one connection; leave ordinary optimistic settings alone. */
export function saveMcpServer(edit: McpServerEdit): Promise<Settings> {
  const run = mcpWrite.catch(() => undefined).then(async () => {
    if (unreadable || !isPlainObject(edit?.server)) throw new Error('Settings are unavailable')
    const server = normaliseSettings({ mcpServers: [edit.server] }).mcpServers[0]
    if (!server?.name.trim() || !(server.transport === 'http' ? server.url?.trim() : server.command?.trim())) throw new Error('Invalid MCP connection')
    const existing = current.mcpServers.find(item => item.id === server.id)
    if (edit.editingId ? edit.editingId !== server.id || !existing : !!existing) throw new Error('This connection changed. Reopen it to edit the current version.')
    const token = server.bearerToken?.trim()
    let rollbackToken: (() => Promise<void>) | undefined
    try {
      if (token) {
        rollbackToken = stageMcpBearerToken(server.id, token)
        await flushMcpSecrets()
      }
      for (;;) {
        const before = current
        // A newer writer may have rotated this credential while we awaited IO.
        if (token && mcpBearerToken(server.id) !== token) throw new Error('This connection credential changed while saving')
        const old = before.mcpServers.find(item => item.id === server.id)
        if (edit.editingId ? !old : !!old) throw new Error('This connection changed while saving')
        const saved = { ...server, bearerToken: token || old?.bearerToken, hasBearerToken: hasMcpBearerToken(server.id) || old?.hasBearerToken }
        const next = normaliseSettings({ ...before, mcpServers: edit.editingId ? before.mcpServers.map(item => item.id === server.id ? saved : item) : [...before.mcpServers, saved] })
        await writeJsonNow(settingsFile(), persistedSettings(next))
        if (current !== before) continue
        current = next; announce(current)
        return current
      }
    } catch (error) {
      // A failed config write must not silently replace the old credential.
      await rollbackToken?.()
      throw error
    }
  })
  mcpWrite = run.catch(() => undefined)
  return run
}

/** Publish the user's identity only once its real write has succeeded. */
export function saveUserProfile(patch: UserProfilePatch): Promise<Settings> {
  const run = profileWrite.catch(() => undefined).then(async () => {
    if (unreadable) throw new Error('Settings are unavailable')
    const fields: UserProfilePatch = {}
    if (Object.hasOwn(patch, 'profileName')) {
      if (typeof patch.profileName !== 'string' || patch.profileName.trim().length > 80) throw new Error('Invalid profile name')
      fields.profileName = patch.profileName.trim()
    }
    if (Object.hasOwn(patch, 'profileImage')) fields.profileImage = canonicalProfileImage(patch.profileImage)
    // Other settings may change while the write is in flight. Re-merge rather
    // than replacing those changes with the profile editor's older snapshot.
    for (;;) {
      const before = current
      const next = normaliseSettings({ ...before, ...fields })
      await writeJsonNow(settingsFile(), persistedSettings(next))
      if (current !== before) continue
      current = next
      announce(current)
      return current
    }
  })
  profileWrite = run.catch(() => undefined)
  return run
}

/** Apply write-only API-key fields from the renderer without ever echoing a key back. */
export function updateSettingsFromRenderer(patch: Partial<Settings>): Settings {
  if (isPlainObject(patch.backends)) {
    // Validate all custom changes before touching the credential store.
    for (const [id, raw] of Object.entries(patch.backends)) {
      if (!isCustomBackendId(id) || !isPlainObject(raw)) continue
      const prior = current.backends[id]
      delete raw['credentialOrigin']
      if (raw['added'] === false) {
        const usedBy = listBots().filter((bot) => bot.backendId === id || bot.executionAgent?.backendId === id)
        if (usedBy.length || (patch.defaultBackendId ?? current.defaultBackendId) === id) {
          throw new Error('该供应商仍被 Bot 或默认模型使用，请先切换后再删除。')
        }
        raw['enabled'] = false
        raw['clearApiKey'] = true
      } else {
        const url = raw['baseUrl'] ?? prior?.baseUrl
        const name = raw['providerName'] ?? prior?.providerName
        const protocol = raw['providerProtocol'] ?? prior?.providerProtocol
        if (typeof url !== 'string' || !originOf(url) || typeof name !== 'string' || !name.trim() || (protocol !== 'openai' && protocol !== 'anthropic')) {
          throw new Error('请填写供应商名称、有效的 HTTP(S) 地址和受支持的协议。')
        }
        if (typeof raw['apiKey'] === 'string' && raw['apiKey'].trim()) raw['credentialOrigin'] = originOf(url) ?? undefined
      }
    }
    for (const [id, raw] of Object.entries(patch.backends)) {
      if ((!KNOWN_BACKEND_IDS.includes(id) && !isCustomBackendId(id)) || !isPlainObject(raw)) continue
      if (raw['clearApiKey'] === true) {
        clearBackendApiKey(id)
        const existing = current.backends[id]
        if (existing) {
          existing.apiKey = ''
          existing.hasApiKey = false
        }
      } else if (typeof raw['apiKey'] === 'string' && raw['apiKey'].trim()) {
        setBackendApiKey(id, raw['apiKey'])
      }
    }
  }
  if (Array.isArray(patch.mcpServers)) {
    const incomingIds = new Set<string>()
    for (const server of patch.mcpServers) {
      if (!server?.id) continue
      incomingIds.add(server.id)
      if (server.clearBearerToken === true) clearMcpBearerToken(server.id)
      else if (server.bearerToken?.trim()) setMcpBearerToken(server.id, server.bearerToken)
    }
    for (const existing of current.mcpServers) {
      if (!incomingIds.has(existing.id) && hasMcpBearerToken(existing.id)) clearMcpBearerToken(existing.id)
    }
  }
  const updated = updateSettings(patch)
  for (const [id, config] of Object.entries(updated.backends)) {
    const stored = backendApiKey(id)
    if (stored) config.apiKey = stored
    config.hasApiKey = hasBackendApiKey(id)
    delete config.clearApiKey
  }
  for (const server of updated.mcpServers) {
    server.bearerToken = mcpBearerToken(server.id)
    server.hasBearerToken = hasMcpBearerToken(server.id)
    delete server.clearBearerToken
  }
  if (!unreadable) writeJsonDebounced(settingsFile(), persistedSettings(updated))
  return updated
}

/** Renderer copy with only secret-presence bits. */
export function rendererSettings(settings: Settings = current): Settings {
  return {
    ...settings,
    backends: Object.fromEntries(Object.entries(settings.backends).map(([id, config]) => [
      id,
      {
        ...config,
        apiKey: '',
        hasApiKey: hasBackendApiKey(id),
        clearApiKey: undefined
      }
    ])),
    mcpServers: settings.mcpServers.map((server) => ({
      ...server,
      bearerToken: '',
      hasBearerToken: hasMcpBearerToken(server.id),
      clearBearerToken: undefined
    }))
  }
}

function persistedSettings(settings: Settings): Settings {
  return {
    ...settings,
    backends: Object.fromEntries(Object.entries(settings.backends).map(([id, config]) => {
      const clean = { ...config }
      delete clean.apiKey
      delete clean.clearApiKey
      clean.hasApiKey = hasBackendApiKey(id)
      return [id, clean]
    })),
    mcpServers: settings.mcpServers.map((server) => {
      const clean = { ...server }
      delete clean.bearerToken
      delete clean.clearBearerToken
      clean.hasBearerToken = hasMcpBearerToken(server.id)
      return clean
    })
  }
}

/**
 * The settings that are lists of strings, and so can be appended to.
 *
 * `-?` because an optional setting would otherwise carry its `undefined` into
 * the key union, and `undefined` is not something this can be indexed by.
 */
export type ListSetting = {
  [K in keyof Settings]-?: Settings[K] extends string[] ? K : never
}[keyof Settings]

/**
 * Add one value to a list setting, if it is not already there.
 *
 * Synchronous on purpose, and the reason this exists at all. `updateSettings`
 * replaces arrays wholesale, so the read-await-write shape
 *
 *     const settings = await store.get()
 *     await store.update({ allowlist: [...settings.allowlist, pattern] })
 *
 * has a microtask boundary in the middle where a second caller reads the same
 * array. Both then write their own one-element addition and the first is gone —
 * clicking "Always allow" on two parked approvals in quick succession lost one
 * rule permanently. Here the read, the membership check and the write happen in
 * one uninterrupted run, so concurrent callers cannot lose each other's values.
 */
/**
 * Notified whenever settings actually change on disk.
 *
 * A callback rather than a direct broadcast so this module keeps no dependency
 * on the IPC layer — settings are read by the tool layer and the agent loop,
 * neither of which should drag Electron in behind them. The IPC layer
 * subscribes at boot.
 */
type SettingsListener = (settings: Settings) => void
const listeners = new Set<SettingsListener>()

export function onSettingsChanged(fn: SettingsListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function announce(settings: Settings): void {
  if (reviewPreference !== (settings.decisionSkillReview === true)) {
    reviewPreference = settings.decisionSkillReview === true
    interruptDecisionReviews()
  }
  noteLocalPermissionSettings(settings)
  for (const fn of listeners) {
    try {
      fn(settings)
    } catch (err) {
      // A broken listener must not fail the write that already succeeded.
      console.warn('[openbot/settings] listener failed', err)
    }
  }
}

export function appendSetting(key: ListSetting, value: string): Settings {
  const entry = typeof value === 'string' ? value.trim() : ''
  if (!entry) return current
  const existing = current[key]
  if (existing.includes(entry)) return current
  return updateSettings({ [key]: [...existing, entry] } as Partial<Settings>)
}

export { defaultSettings } from './settingsSchema'
