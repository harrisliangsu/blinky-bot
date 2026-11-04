/**
 * main -> renderer push. The agent loop, tool runner and recorder all emit
 * through `broadcast()`; nothing else in the main process talks to the
 * renderer directly.
 */

import { BrowserWindow, Notification } from 'electron'
import type { AgentEvent } from '../../shared/types'
import { EVENT_CHANNEL, MENU_CHANNEL, type MenuCommand } from './channels'
import { addActivity } from '../store/activity'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { hasActiveTask } from '../store/tasks'
import { focusOrCreateWindow } from '../app/window'

const failedRuns = new Set<string>()

/**
 * Every live window, focused or not.
 *
 * Addressing only the focused one drops events whenever focus is somewhere
 * unexpected — another app window, or nothing at all — and an agent run is
 * exactly the situation where the user has clicked away.
 */
function targets(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed()
  )
}

function send(channel: string, payload: unknown): void {
  for (const win of targets()) {
    try {
      win.webContents.send(channel, payload)
    } catch (err) {
      console.error('[openbot/ipc] send failed', channel, err)
    }
  }
}

/** Push one streaming event to the renderer. Never throws. */
export function broadcast(event: AgentEvent): void {
  send(EVENT_CHANNEL, event)
  if (event.type === 'activity-updated' || event.type === 'task-updated') return

  if (event.type === 'message-start' && event.message.role === 'assistant') {
    failedRuns.delete(event.sessionId)
  }

  if (event.type === 'human-help-request') {
    const bot = getBot(event.request.botId)
    postActivity('help', `${bot?.name ?? 'A bot'} needs you`, event.request.reason, event.request.sessionId, event.request.botId, true)
  } else if (event.type === 'approval-request') {
    postActivity('approval', 'Approval needed', event.request.summary, event.request.sessionId, undefined, true)
  } else if (event.type === 'error') {
    failedRuns.add(event.sessionId)
    /*
     * A background task posts its own inbox item — carrying the task's title
     * and its final status — when the run settles, so one here as well gave
     * every failed task two entries that told different stories. The session is
     * still marked failed, which is what keeps the `done` below quiet.
     */
    if (!hasActiveTask(event.sessionId)) {
      postActivity('failed', getSession(event.sessionId)?.title ?? 'Agent run failed', event.message, event.sessionId, undefined, true)
    }
  } else if (event.type === 'done') {
    const failed = failedRuns.delete(event.sessionId)
    /*
     * `hasActiveTask` for the same reason as the `error` branch above: the task
     * pipeline posts its own item when the run settles, and `done` is broadcast
     * while the record is still `running`. Without this guard a background task
     * finishing with the window unfocused — the normal case for background work
     * — posted "The bot finished while OpenBOT was in the background" and then
     * "Background agent task completed" for the one run.
     */
    if (!failed && !hasActiveTask(event.sessionId) && BrowserWindow.getFocusedWindow() === null) {
      postActivity('completed', getSession(event.sessionId)?.title ?? 'Agent run completed', 'The bot finished while BlinkyBot was in the background.', event.sessionId)
    }
  }
}

/**
 * Record one inbox item, push it, and raise a desktop notification for it.
 *
 * Exported because the background-task pipeline owns the entry for its own runs
 * (see the `error` branch above) and still has to be able to raise the
 * notification the skipped event would have raised.
 */
export function postActivity(
  kind: 'approval' | 'help' | 'completed' | 'failed',
  title: string,
  detail: string,
  sessionId?: string,
  botId?: string,
  notify = false
): void {
  const item = addActivity(kind, title, detail, { ...(sessionId ? { sessionId } : {}), ...(botId ? { botId } : {}) })
  send(EVENT_CHANNEL, { type: 'activity-updated', item } satisfies AgentEvent)
  if (!notify || BrowserWindow.getFocusedWindow() !== null || !Notification.isSupported()) return
  const notification = new Notification({ title, body: detail.slice(0, 240), silent: false })
  notification.on('click', () => focusOrCreateWindow())
  notification.show()
}

/** Push a native-menu command (New Chat, Settings) to the renderer. */
export function sendMenuCommand(command: MenuCommand): void {
  send(MENU_CHANNEL, command)
}
