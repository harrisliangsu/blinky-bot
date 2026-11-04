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
import { registerUpdateIpc } from './updates'
import { registerWindowIpc } from './window'
import { registerSearchIpc } from './search'
import { registerActivityIpc } from './activity'
import { registerGroupIpc } from './groups'
import { registerRoomIpc } from './rooms'

export function registerIpc(): void {
  registerSearchIpc()
  registerActivityIpc()
  registerGroupIpc()
  registerRoomIpc()
  registerSessionIpc()
  registerProjectIpc()
  registerBotIpc()
  registerRoutineIpc()
  registerAgentIpc()
  registerBackendIpc()
  registerAppIpc()
  registerSettingsIpc()
  registerSkillIpc()
  registerDialogIpc()
  registerWindowIpc()
  registerUpdateIpc()
}

export { broadcast, sendMenuCommand } from './broadcast'
export { CHANNELS, EVENT_CHANNEL, MENU_CHANNEL, type MenuCommand } from './channels'
