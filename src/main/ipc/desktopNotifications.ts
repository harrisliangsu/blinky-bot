import { shell } from 'electron'
import { handleEvent } from './handler'
import { notificationStatus, showDesktopNotification, installDesktopNotifications } from '../desktopNotifications'
export function registerDesktopNotificationIpc(): void {
  void installDesktopNotifications()
  handleEvent('openbot:notification:status', () => notificationStatus(), () => ({ supported: false, state: 'failed' as const, enabled: false, replies: false }))
  handleEvent('openbot:notification:test', () => showDesktopNotification('test', undefined, true), () => false)
  handleEvent('openbot:notification:settings', () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'), () => undefined)
}
