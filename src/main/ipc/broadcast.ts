/**
 * main -> renderer push. The agent loop, tool runner and recorder all emit
 * through `broadcast()`; nothing else in the main process talks to the
 * renderer directly.
 */

import { publishDesktopEvent } from './eventBus'
import { BrowserWindow } from 'electron'
import { getSettings } from '../settings'
import type { AgentEvent } from '../../shared/types'
import { summariseSession } from '../../shared/sessionSummary'
import { summariseTask } from '../../shared/activity'
import { observesSession } from './sessionObservation'
import { EVENT_CHANNEL, MENU_CHANNEL, type MenuCommand } from './channels'
import { addActivity } from '../store/activity'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { hasActiveTask } from '../store/tasks'
import { showDesktopNotification } from '../desktopNotifications'
import { ReplyCompletion } from '../replyCompletion'
import { sendNativeEvent } from '../native/stdioBridge'
import { routineOwnsNotifications } from '../routines/notificationOwnership'
import { taskJudgmentScope } from '../agent/taskJudgmentScope'

const failedRuns = new Set<string>()
const replyCompletion = new ReplyCompletion()

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
  if (channel === EVENT_CHANNEL) publishDesktopEvent(payload as AgentEvent)
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
  publishDesktopEvent(event)
  sendNativeEvent(event)
  // Runtime listeners and the native bridge retain their original contract.
  // A window only receives history for its two visible conversations.
  for (const win of targets()) {
    const payload: AgentEvent = event.type === 'session-updated' && !observesSession(win.webContents, event.session.id)
      ? { type: 'session-summary-updated', summary: summariseSession(event.session) }
      : event.type === 'task-updated' ? { type: 'task-summary-updated', task: summariseTask(event.task) } : event
    try { win.webContents.send(EVENT_CHANNEL, payload) }
    catch (err) { console.error('[openbot/ipc] send failed', EVENT_CHANNEL, err) }
  }
  const reply = replyCompletion.observe(event, (sessionId, messageId) => getSession(sessionId)?.messages.find(message => message.id === messageId))
  if (event.type === 'activity-updated' || event.type === 'task-updated') return
  // Preserve the live event for every UI/native consumer. Only the generic
  // completion activity/notification is owned by the routine ledger instead.
  if ((event.type === 'done' || event.type === 'error') && (routineOwnsNotifications(event.sessionId) || taskJudgmentScope(event.sessionId))) {
    failedRuns.delete(event.sessionId)
    return
  }

  if (event.type === 'run-started' || event.type === 'message-start' && event.message.role === 'assistant') {
    failedRuns.delete(event.sessionId)
  }

  if (event.type === 'human-help-request') {
    const bot = getBot(event.request.botId)
    postActivity('help', `${bot?.name ?? 'A bot'} needs you`, event.request.reason, event.request.sessionId, event.request.botId, true, event.request.id)
  } else if (event.type === 'approval-request') {
    postActivity('approval', 'Approval needed', event.request.summary, event.request.sessionId, undefined, true, event.request.id)
  } else if (event.type === 'error') {
    const alreadyFailed = failedRuns.has(event.sessionId)
    failedRuns.add(event.sessionId)
    /*
     * A background task posts its own inbox item — carrying the task's title
     * and its final status — when the run settles, so one here as well gave
     * every failed task two entries that told different stories. The session is
     * still marked failed, which is what keeps the `done` below quiet.
     */
    if (!alreadyFailed && !hasActiveTask(event.sessionId)) {
      postActivity('failed', getSession(event.sessionId)?.title ?? 'Agent run failed', event.message, event.sessionId, undefined, true)
    }
  } else if (event.type === 'done') {
    failedRuns.delete(event.sessionId)
    if (reply && !hasActiveTask(event.sessionId)) {
      const session = getSession(event.sessionId)
      const botId = session?.messages.find(message => message.id === reply)?.botId ?? session?.activeBotId
      postActivity('completed', getBot(botId ?? '')?.name ?? 'AI reply',
        getSettings().language === 'en' ? 'A reply is ready.' : '回复已完成。', event.sessionId, botId, 'reply', reply)
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
  kind: 'info' | 'approval' | 'help' | 'completed' | 'failed',
  title: string,
  detail: string,
  sessionId?: string,
  botId?: string,
  notify: boolean | 'reply' = false,
  messageId = ''
): void {
  const item = addActivity(kind, title, detail, { ...(sessionId ? { sessionId } : {}), ...(botId ? { botId } : {}) })
  send(EVENT_CHANNEL, { type: 'activity-updated', item } satisfies AgentEvent)
  if (notify) showDesktopNotification(kind, sessionId ? { sessionId, ...(botId ? { botId } : {}) } : undefined, notify === 'reply', messageId)
}

/** Push a native-menu command (New Chat, Settings) to the renderer. */
export function sendMenuCommand(command: MenuCommand): void {
  send(MENU_CHANNEL, command)
}
