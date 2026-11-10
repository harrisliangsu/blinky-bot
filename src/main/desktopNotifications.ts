import { BrowserWindow, Notification } from 'electron'
import { getSettings, onSettingsChanged } from './settings'
import { focusOrCreateWindow } from './app/window'
import { getSession } from './store/sessions'
import type { NotificationStatus, NotificationTarget } from '../shared/desktopNotifications'

const live = new Map<string, Notification>()
let state: NotificationStatus['state'] = 'idle'
let sequence = 0
const delivered = new Set<string>()
const channel = 'openbot:notification:open'
export function notificationStatus(): NotificationStatus {
  const settings = getSettings()
  return { supported: Notification.isSupported(), state, enabled: settings.notifications !== false, replies: settings.notifyOnTurn === true }
}
function attach(notification: Notification, target?: NotificationTarget): void {
  notification.on('click', () => {
    const win = focusOrCreateWindow()
    if (!target || !getSession(target.sessionId)) return
    const send = (): void => { if (!win.isDestroyed()) win.webContents.send(channel, target) }
    if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send)
    else send()
  })
  notification.on('close', () => live.delete(notification.id))
}
/** Content-free OS notifications honor the master switch; reply notifications also work while active. */
export function showDesktopNotification(kind: string, target?: NotificationTarget, reply = false, messageId = ''): boolean {
  const settings = getSettings()
  if (settings.notifications === false || !Notification.isSupported() || (reply && settings.notifyOnTurn !== true)) return false
  const focused = BrowserWindow.getFocusedWindow()
  if (!reply && kind !== 'test' && focused?.isVisible() && !focused.isMinimized()) return false
  // A failed OS delivery is not permission to repeatedly prompt the system. An explicit test may retry.
  if (state === 'failed' && kind !== 'test') return false
  const dedupe = messageId && target ? `${kind}:${target.sessionId}:${messageId}` : ''
  if (dedupe && delivered.has(dedupe)) return false
  const zh = settings.language !== 'en'
  const body = kind === 'task-returned' ? (zh ? 'Bot 有新的任务消息。点击查看。' : 'Your Bot has a task update. Click to view.') : kind === 'test' ? (zh ? '这是一条测试通知。' : 'This is a test notification.') : kind === 'completed' ? (zh ? 'AI 回复已完成。点击查看。' : 'An AI reply is ready. Click to view.')
    : kind === 'approval' || kind === 'help' ? (zh ? '有事项需要确认。点击查看。' : 'Your attention is needed. Click to view.')
      : (zh ? '有一项工作未能完成。点击查看。' : 'A task could not finish. Click to view.')
  const id = target ? `blinky-${reply ? 'reply' : 'task'}:${encodeURIComponent(target.sessionId)}:${encodeURIComponent(target.botId ?? '')}:${encodeURIComponent(messageId)}` : undefined
  let notification: Notification
  try { notification = new Notification({ ...(id ? { id } : {}), title: 'BlinkyBot', body, silent: false }) } catch { state = 'failed'; return false }
  live.set(notification.id, notification)
  if (live.size > 100) { const oldest = live.keys().next().value!; live.get(oldest)?.close(); live.delete(oldest) }
  attach(notification, target)
  state = 'requested'
  const request = ++sequence
  const timer = setTimeout(() => { if (request === sequence && state === 'requested') state = 'unconfirmed' }, 8000); timer.unref()
  notification.on('show', () => { clearTimeout(timer); if (request === sequence) state = 'shown' })
  notification.on('failed', () => { clearTimeout(timer); if (request === sequence) state = 'failed'; live.delete(notification.id); if (dedupe) delivered.delete(dedupe) })
  try { notification.show(); if (dedupe) { delivered.add(dedupe); if (delivered.size > 1000) delivered.delete(delivered.values().next().value!) }; return true } catch { clearTimeout(timer); state = 'failed'; live.delete(notification.id); return false }
}
export async function installDesktopNotifications(): Promise<void> {
  onSettingsChanged(settings => {
    if (settings.notifications === false || settings.notifyOnTurn !== true) {
      if (settings.notifications === false) { sequence++; state = 'idle' }
      for (const [id, notice] of live) if (settings.notifications === false || id.startsWith('blinky-reply:')) { notice.close(); live.delete(id) }
    }
  })
  // Recover click ownership after restart, without replaying notifications.
  if (typeof Notification.getHistory !== 'function') return
  try {
    for (const notice of await Notification.getHistory()) {
      const parts = notice.id.split(':')
      if (!['blinky-reply', 'blinky-task'].includes(parts[0]) || parts.length !== 4) continue
      const sessionId = decodeURIComponent(parts[1]), botId = decodeURIComponent(parts[2])
      if (!getSession(sessionId)) continue
      attach(notice, { sessionId, ...(botId ? { botId } : {}) }); live.set(notice.id, notice)
    }
  } catch { /* Unsupported or blocked by macOS. The settings panel reports unconfirmed delivery. */ }
}
