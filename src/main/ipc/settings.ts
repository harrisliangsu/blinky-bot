/** IPC for `OpenBotApi.settings`. Validation and merging live in the schema. */

import type { Settings } from '../../shared/types'
import type { UserProfilePatch, UserProfileSaveResult } from '../../shared/settings'
import {
  getSettings,
  onSettingsChanged,
  rendererSettings,
  saveUserProfile,
  saveDecisionSkillReview,
  saveMcpServer,
  savePermissionEdit,
  updateSettingsFromRenderer
} from '../settings'
import { syncBotBindings } from '../store/bots'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { handle } from './handler'
import { asPatch } from './validate'

export function registerSettingsIpc(): void {
  handle<import('../../shared/settings').PermissionSaveResult>(CHANNELS.settingsSaveDecisionReview, async ([enabled]) => ({
    ok: true, settings: rendererSettings(await saveDecisionSkillReview(enabled))
  }), () => ({ ok: false, error: '决策复审设置未能保存，请重试。 / Decision review could not be saved. Try again.' }))
  handle<import('../../shared/settings').McpServerSaveResult>(CHANNELS.settingsSaveMcpServer, async ([edit]) => ({
    ok: true, settings: rendererSettings(await saveMcpServer(edit as import('../../shared/settings').McpServerEdit))
  }), () => ({ ok: false, error: 'MCP 连接未能保存，草稿已保留，请重试。 / The MCP connection could not be saved. Your draft is kept; try again.' }))
  handle<import('../../shared/settings').PermissionSaveResult>(CHANNELS.settingsEditPermission, async ([edit]) => ({
    ok: true, settings: rendererSettings(await savePermissionEdit(edit as import('../../shared/settings').PermissionEdit))
  }), (_args, error) => ({ ok: false, error: error instanceof Error ? error.message : '权限设置未能保存。 / Permission settings could not be saved.' }))
  handle<UserProfileSaveResult>(CHANNELS.settingsSaveProfile, async ([patch]) => ({
    ok: true, settings: rendererSettings(await saveUserProfile(asPatch<UserProfilePatch>(patch)))
  }), () => ({ ok: false, error: '个人资料未能保存，请重试。 / Your profile could not be saved. Try again.' }))
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
