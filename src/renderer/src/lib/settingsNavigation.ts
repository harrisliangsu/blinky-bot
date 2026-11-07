/**
 * Which settings tab opens with the dialog.
 *
 * The panel is unmounted while it is closed, so the next open reads this
 * once. Chat errors that need a CLI or provider land on that section;
 * everything else still opens on General. An older `mcp` request opens Tools.
 */

import { store } from '../state'

export const SETTINGS_SECTIONS = [
  'general',
  'bots',
  'profile',
  'notifications',
  'permissions',
  'backends',
  'vault',
  'apps',
  'tools',
  'updates',
  'about'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** `mcp` remains so older callers land on Tools instead of Apps. */
export type SettingsTab = SettingsSection | 'mcp'

const KEY = 'openbot:settings-position'
let initialTab: SettingsTab | undefined
let remembered: SettingsSection = 'general'
let scrolls: Partial<Record<SettingsSection, { main: number; body: number }>> = {}
try {
  const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  if (SETTINGS_SECTIONS.includes(value.section)) remembered = value.section
  if (value.scrolls && typeof value.scrolls === 'object') for (const section of SETTINGS_SECTIONS) {
    const saved = value.scrolls[section]
    if (Number.isFinite(saved)) scrolls[section] = { main: Math.max(0, saved), body: 0 }
    else if (saved && typeof saved === 'object') scrolls[section] = { main: Number.isFinite(saved.main) ? Math.max(0, saved.main) : 0, body: Number.isFinite(saved.body) ? Math.max(0, saved.body) : 0 }
  }
} catch { /* Missing storage or legacy invalid values retain defaults. */ }
function persist(): void { try { localStorage.setItem(KEY, JSON.stringify({ section: remembered, scrolls })) } catch { /* Session memory still works. */ } }
export function rememberSettingsSection(tab: SettingsSection): void { if (tab === 'apps' || tab === 'tools') return; remembered = tab; persist() }
export function settingsScroll(tab: SettingsSection, container: 'main' | 'body' = 'main'): number { return scrolls[tab]?.[container] ?? 0 }
export function saveSettingsScroll(tab: SettingsSection, top: number, container: 'main' | 'body' = 'main'): void { scrolls[tab] = { main: 0, body: 0, ...scrolls[tab], [container]: Math.max(0, top) }; persist() }
/** An explicit deep link wins; opening Preferences without one resumes the last category. */
export function openSettings(tab?: SettingsTab): void {
  initialTab = tab
  if (store.getState().modal === 'settings') window.dispatchEvent(new Event('openbot:settings-tab'))
  else store.setModal('settings')
}
export function takeSettingsTab(): SettingsSection {
  const tab = initialTab ?? remembered; initialTab = undefined
  if (tab === 'mcp') return 'tools'
  return (SETTINGS_SECTIONS as readonly string[]).includes(tab) ? tab as SettingsSection : remembered
}
