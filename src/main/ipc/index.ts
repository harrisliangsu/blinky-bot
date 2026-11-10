import { registerDesktopNotificationIpc } from './desktopNotifications'
import { registerVoiceIpc } from './voice'
/**
 * IPC entry point. One call registers every `OpenBotApi` channel; the rest of
 * the main process pushes to the renderer through `broadcast()`.
 */

import { registerAgentIpc } from './agent'
import { registerAppIpc } from './apps'
import { registerBackendIpc } from './backends'
import { registerBotIpc } from './bots'
import { registerDialogIpc } from './dialog'
import { registerProjectIpc } from './projects'
import { registerRoutineIpc } from './routines'
import { registerSessionIpc } from './sessions'
import { registerSettingsIpc } from './settings'
import { registerSkillIpc } from './skills'
import { registerAgentsMdIpc } from './agentsMd'
import { registerSystemPermissionIpc } from './systemPermissions'
import { registerUpdateIpc } from './updates'
import { registerWindowIpc } from './window'
import { registerSearchIpc } from './search'
import { registerActivityIpc } from './activity'
import { registerGroupIpc } from './groups'
import { registerRoomIpc } from './rooms'
import { registerVaultIpc } from './vault'
import { registerGitHubDraftIpc } from './githubDrafts'
import { registerGmailDraftIpc } from './gmailDrafts'
import { registerCalendarDraftIpc } from './calendarDrafts'
import { registerXDraftIpc } from './xDrafts'
import { registerSlackDraftIpc } from './slackDrafts'

export function registerIpc(): void {
  registerVoiceIpc()
  registerDesktopNotificationIpc()
  registerSearchIpc()
  registerActivityIpc()
  registerGroupIpc()
  registerRoomIpc()
  registerVaultIpc()
  registerGitHubDraftIpc()
  registerGmailDraftIpc()
  registerCalendarDraftIpc()
  registerXDraftIpc()
  registerSlackDraftIpc()
  registerSessionIpc()
  registerProjectIpc()
  registerBotIpc()
  registerRoutineIpc()
  registerAgentIpc()
  registerBackendIpc()
  registerAppIpc()
  registerSettingsIpc()
  registerSkillIpc()
  registerAgentsMdIpc()
  registerSystemPermissionIpc()
  registerDialogIpc()
  registerWindowIpc()
  registerUpdateIpc()
}

export { broadcast, sendMenuCommand } from './broadcast'
export { CHANNELS, EVENT_CHANNEL, MENU_CHANNEL, type MenuCommand } from './channels'
