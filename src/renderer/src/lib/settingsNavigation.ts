/**
 * Which settings tab opens with the dialog.
 *
 * The panel is unmounted while it is closed, so the next open reads this
 * once. Chat errors that need a backend land on Backends; everything else
 * still opens on General.
 */

import { store } from '../state'

export type SettingsTab = 'general' | 'permissions' | 'backends' | 'apps' | 'mcp'

let initialTab: SettingsTab = 'general'

export function openSettings(tab: SettingsTab = 'general'): void {
  initialTab = tab
  store.setModal('settings')
}

export function takeSettingsTab(): Exclude<SettingsTab, 'mcp'> {
  const tab = initialTab
  initialTab = 'general'
  return tab === 'mcp' ? 'apps' : tab
}
