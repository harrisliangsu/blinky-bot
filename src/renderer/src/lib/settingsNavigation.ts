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
  'apps',
  'tools',
  'updates',
  'about'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** `mcp` remains so older callers land on Tools instead of Apps. */
export type SettingsTab = SettingsSection | 'mcp'

let initialTab: SettingsTab = 'general'

export function openSettings(tab: SettingsTab = 'general'): void {
  initialTab = tab
  store.setModal('settings')
}

export function takeSettingsTab(): SettingsSection {
  const tab = initialTab
  initialTab = 'general'
  if (tab === 'mcp') return 'tools'
  return (SETTINGS_SECTIONS as readonly string[]).includes(tab) ? (tab as SettingsSection) : 'general'
}
