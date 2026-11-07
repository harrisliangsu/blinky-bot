import type { Settings } from '../../../shared/types'
import type { UserProfilePatch, UserProfileSaveResult } from '../../../shared/settings'
import { bridge, errText } from './bridge'
import { store } from './core'

let settingsWrite: Promise<Settings | undefined> = Promise.resolve(undefined)
let settingsRevision = 0
const pendingSettings = new Map<number, Partial<Settings>>()

/** Share the settings write queue, but keep profile drafts local until saved. */
export async function saveUserProfile(patch: UserProfilePatch): Promise<UserProfileSaveResult> {
  const request = settingsWrite.then(() => bridge().settings.saveProfile(patch))
  settingsWrite = request.then(() => undefined, () => undefined)
  try {
    const result = await request
    if (result.ok) store.patch({ settings: withPendingSettings(result.settings), settingsError: null })
    return result
  } catch {
    return { ok: false, error: '个人资料未能保存，请重试。 / Your profile could not be saved. Try again.' }
  }
}

/** MCP form drafts are published only after an explicit successful save. */
export async function saveMcpServer(edit: import('../../../shared/settings').McpServerEdit): Promise<import('../../../shared/settings').McpServerSaveResult> {
  const request = settingsWrite.then(() => bridge().settings.saveMcpServer(edit))
  settingsWrite = request.then(() => undefined, () => undefined)
  try {
    const result = await request
    if (result.ok) store.patch({ settings: withPendingSettings(result.settings), settingsError: null })
    return result
  } catch {
    return { ok: false, error: 'MCP 连接未能保存，草稿已保留，请重试。 / The MCP connection could not be saved. Your draft is kept; try again.' }
  }
}

/** Keep main-process broadcasts from erasing newer optimistic renderer edits. */
export function withPendingSettings(settings: Settings): Settings {
  let merged = settings
  for (const patch of pendingSettings.values()) merged = { ...merged, ...patch }
  return merged
}

export async function loadSettings(): Promise<void> {
  try {
    store.patch({ settings: await bridge().settings.get(), settingsError: null })
  } catch (e) {
    store.patch({ settingsError: errText(e) })
  }
}

/** Optimistic: the panel stays responsive, and rolls back if the write fails. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const prev = store.getState().settings
  const revision = ++settingsRevision
  pendingSettings.set(revision, patch)
  if (prev) store.patch({ settings: { ...prev, ...patch } })
  const request = settingsWrite.then(() => bridge().settings.update(patch))
  settingsWrite = request.catch(() => undefined)
  try {
    const saved = await request
    pendingSettings.delete(revision)
    // Sliders and toggles can issue several writes before the first answer.
    // Only the newest response may replace the newest optimistic snapshot.
    if (revision === settingsRevision) store.patch({ settings: saved, settingsError: null })
  } catch (e) {
    pendingSettings.delete(revision)
    if (revision === settingsRevision) store.patch({ settings: prev, settingsError: errText(e) })
  }
}

/** One chip added or removed, rather than a wholesale replacement. */
export interface ListEdit {
  kind: 'add' | 'remove'
  value: string
}

/** The settings the permissions panel edits chip by chip. */
export type SettingsListKey = 'allowlist' | 'denylist' | 'computerUseAllowedApps'

/** The edit, applied to whatever the list holds right now. */
export function applyListEdit(items: readonly string[], edit: ListEdit): string[] {
  if (edit.kind === 'remove') return items.filter((x) => x !== edit.value)
  return items.includes(edit.value) ? items.slice() : [...items, edit.value]
}

/**
 * Change one entry of a settings list, against a freshly read copy.
 *
 * The panel used to send the WHOLE array from its snapshot, and that snapshot is
 * only refreshed at boot and by the refresh button — there is no event telling
 * the renderer that settings changed. Meanwhile the agent writes rules of its
 * own every time the user answers an approval with "always approve". So:
 * allowlist shows two rules, the agent persists a third, the user deletes one
 * chip, and the two-item array that goes back destroys the agent's rule along
 * with the intended removal. Reading first, then applying one edit, means a rule
 * we never saw is carried through untouched.
 */
export async function editSettingsList(key: SettingsListKey, edit: ListEdit): Promise<void> {
  const revision = ++settingsRevision
  let read = false

  /*
   * The read and the write are ONE link in the write chain.
   *
   * `updateSettings` already serialises writes, but this function read first and
   * that read sat outside the chain — so two edits issued before the first write
   * landed both saw the pre-edit list, and the second sent an array computed
   * from it. Adding two denylist entries in quick succession kept only the
   * second; revoking two allowlist rules revoked only one, leaving a permission
   * the user watched disappear from the panel still in force. Main's
   * `appendSetting` is deliberately synchronous for this reason; the panel needs
   * the same guarantee, which here means nothing may read between a queued edit
   * and its own write.
   */
  const run = settingsWrite.then(async (): Promise<Settings> => {
    const current = await bridge().settings.get()
    read = true
    const patch = { [key]: applyListEdit(current[key], edit) } as Partial<Settings>
    pendingSettings.set(revision, patch)
    /*
     * Adopt what was just read, so the panel also stops showing a stale list —
     * but keep any write still in flight on top of it. A bare `current` is disk
     * as it was before those writes, so adding one chip visibly reverted an
     * optimistic edit sitting in another field until its own answer arrived.
     */
    store.patch({ settings: withPendingSettings({ ...current, ...patch }), settingsError: null })
    return bridge().settings.update(patch)
  })
  settingsWrite = run.then(
    () => undefined,
    () => undefined
  )

  try {
    const saved = await run
    pendingSettings.delete(revision)
    if (revision === settingsRevision) store.patch({ settings: saved, settingsError: null })
  } catch (e) {
    pendingSettings.delete(revision)
    store.patch({ settingsError: errText(e) })
    // Refusing to write beats writing a stale list: the whole point is that the
    // array we hold may be missing rules the agent added.
    store.toast(
      read
        ? 'Settings could not be saved, so nothing was changed.'
        : 'Settings could not be read, so nothing was changed.',
      'error'
    )
  }
}

export async function recheckBackend(id: string): Promise<void> {
  try {
    const next = await bridge().backends.recheck(id)
    if (next.length) store.patch({ backends: next, backendsError: null })
  } catch (e) {
    store.patch({ backendsError: errText(e) })
  }
}

/** Opens Terminal with that CLI's own login. The CLI keeps the credential. */
export async function loginBackend(id: string): Promise<boolean> {
  try {
    const result = await bridge().backends.login(id)
    return result.started === true
  } catch {
    return false
  }
}

export async function loadBackends(refresh = false): Promise<void> {
  store.patch({ backendsLoading: true, backendsError: null })
  try {
    const api = bridge().backends
    store.patch({ backends: refresh ? await api.refresh() : await api.list(), backendsLoading: false })
  } catch (e) {
    store.patch({ backendsLoading: false, backendsError: errText(e) })
  }
}
