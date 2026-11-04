/** IPC for `OpenBotApi.settings`. Validation and merging live in the schema. */

import type { Settings } from '../../shared/types'
import {
  getSettings,
  onSettingsChanged,
  rendererSettings,
  updateSettingsFromRenderer
} from '../settings'
import { syncBotBindings } from '../store/bots'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { handle } from './handler'
import { asPatch } from './validate'

export function registerSettingsIpc(): void {
  handle<Settings>(CHANNELS.settingsGet, () => rendererSettings(), () => rendererSettings(getSettings()))
  handle<Settings>(
    CHANNELS.settingsUpdate,
    ([patch]) => {
      const settings = updateSettingsFromRenderer(asPatch<Settings>(patch))
      syncBotBindings()
      return rendererSettings(settings)
    },
    () => rendererSettings(getSettings())
  )

  /*
   * The agent writes settings too — "always allow" persists a rule — and the
   * renderer had no way to hear about it. Its permissions panel kept the list
   * it fetched at boot, so editing anything there sent that stale array back
   * and destroyed whatever the agent had added in the meantime.
   */
  onSettingsChanged((settings) => broadcast({ type: 'settings-updated', settings: rendererSettings(settings) }))
}
