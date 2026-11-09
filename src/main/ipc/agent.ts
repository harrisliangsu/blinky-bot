/**
 * IPC for `OpenBotApi.agent` — the three channels that drive a turn.
 * Message bookkeeping belongs to the agent loop; this layer only validates,
 * delegates, and makes sure a failure surfaces as an `error` event instead of
 * a rejected promise in the renderer.
 */

import { getSession } from '../store/sessions'
import { AGENT_UNAVAILABLE, loopFn } from './agentRuntime'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { handleVoid } from './handler'
import { asAttachments, asDecision, asId, asString } from './validate'
import { returnHumanControl } from '../tools/agent/help'
import { handle, handleEvent, type Handler } from './handler'
import type { MessageQueue } from '../../shared/messageQueue'
import { enqueueMessage, getMessageQueue, pauseQueueIfNeeded, setQueuePaused } from '../store/messageQueue'
import { announceQueue, drainQueue, isQueueDraining, isQueueSuspended, queueSuspensionGeneration, removeQueuedItem, suspendQueue, unsuspendQueue } from '../agent/messageQueueRuntime'
import { isRunning } from '../agent/cancel'
import { cancelBackgroundTask } from '../tasks'
import { listTasks } from '../store/tasks'
import { beginQueueWrite, cancelStart, endQueueWrite, hasPendingQueueWrite, isStartCancelled, isStarting, releaseStart, reserveStart } from '../agent/startReservation'
import { steerCodexTurn } from '../backends/cli/codexAppServer'
import { sessions } from '../agent/sessionGateway'
import { addNotice, addUserMessage } from '../agent/messages'
import { getSettings } from '../settings'
import { getBot } from '../store/bots'
import { startTurn } from './startTurn'
import { captureUserPreference } from '../agent/memoryPreferences'
import { liveMessages } from '../agent/liveMessages'
import { emitTelemetry } from '../telemetry'
import { unreadableRecord } from './readFailure'
import type { Message } from '../../shared/types'
import { traceChatTiming } from '../backends/chatTiming'
import { registerNativeHandler } from '../native/stdioBridge'
import { consumeGmailUserIntent } from '../agent/gmailUserIntent'

function fail(sessionId: string, message: string): void {
  broadcast({ type: 'error', sessionId, message })
  broadcast({ type: 'done', sessionId })
}

/** A local user command has no model run. Clear its optimistic spinner only
 * while the session is actually idle; never end a different live turn. */
function finishLocalUserIntent(sessionId: string): void {
  if (!isRunning(sessionId) && !isStarting(sessionId) && !isQueueDraining(sessionId) && !hasPendingQueueWrite(sessionId)) broadcast({ type: 'done', sessionId })
}

export function registerAgentIpc(): void {
  handle<Message[]>(CHANNELS.agentLiveMessages, ([sessionId]) => liveMessages(asId(sessionId)), unreadableRecord)
  handle<boolean>('openbot:agent:isRunning', ([sessionId]) => isRunning(asId(sessionId)), () => false)
  handle<boolean>('openbot:agent:steer', async ([sessionId, text]) => {
    const id = asId(sessionId)
    const body = asString(text).trim()
    if (!body || !isRunning(id) || !getSession(id)) return false
    return steerCodexTurn(id, body, async () => {
      const session = await sessions.get(id)
      if (!session) throw new Error('The conversation was removed after steering was accepted.')
      await addUserMessage(session, body, undefined, false)
    })
  }, () => false)
  handle<MessageQueue | null>('openbot:agent:queue', ([sessionId]) => getMessageQueue(asId(sessionId)), () => null)
  const enqueue: Handler<MessageQueue | null> = async ([sessionId, text, attachments]) => {
    const id = asId(sessionId)
    traceChatTiming(id, 'submit-received')
    if (!getSession(id)) throw new Error('That conversation no longer exists.')
    beginQueueWrite(id)
    try {
      const body = asString(text)
      const files = asAttachments(attachments)
      const queue = await enqueueMessage(id, body, files, isQueueSuspended(id))
      emitTelemetry({ kind: 'queue.enqueued', sessionId: id, size: body.length })
      const queued = queue.items.at(-1)
      if (queued) {
        try {
          const session = await sessions.get(id)
          if (!session) throw new Error('That conversation no longer exists.')
          await addUserMessage(session, body, files, false, queued.id, queued.createdAt)
          await captureUserPreference(body, queued.id)
        } catch (error) {
          suspendQueue(id)
          await pauseQueueIfNeeded(id)
          announceQueue(id)
          throw error
        }
      }
      announceQueue(id)
      return queue
    } finally {
      endQueueWrite(id)
      void drainQueue(id)
    }
  }
  // Native transport keeps the original queue semantics. Only the trusted
  // renderer event path can interpret a local message as send authorization.
  registerNativeHandler('openbot:agent:enqueue', enqueue)
  handleEvent<MessageQueue | null>('openbot:agent:enqueue', async (event, args) => {
    const id = asId(args[0]), body = asString(args[1]), files = asAttachments(args[2])
    const intent = await consumeGmailUserIntent(event.sender.id, id, body, files)
    if (!intent.consumed) return enqueue(args)
    finishLocalUserIntent(id)
    return intent.accepted ? getMessageQueue(id) : null
  }, () => null)
  handle<MessageQueue | null>('openbot:agent:pauseQueue', async ([sessionId, paused]) => {
    const id = asId(sessionId)
    if (typeof paused !== 'boolean') throw new TypeError('Expected a pause state.')
    if (paused) suspendQueue(id)
    const generation = queueSuspensionGeneration(id)
    const queue = await setQueuePaused(id, paused)
    if (!paused && queueSuspensionGeneration(id) === generation) unsuspendQueue(id)
    announceQueue(id)
    if (!paused && queueSuspensionGeneration(id) === generation) void drainQueue(id)
    return queue
  }, () => null)
  handle<MessageQueue | null>('openbot:agent:removeQueued', async ([sessionId, itemId]) => {
    const id = asId(sessionId)
    const generation = queueSuspensionGeneration(id)
    const queue = await removeQueuedItem(id, asId(itemId))
    if (!queue.items.length && queueSuspensionGeneration(id) === generation) unsuspendQueue(id)
    announceQueue(id)
    return queue
  }, () => null)
  handle<boolean>(CHANNELS.agentReturnControl, ([requestId]) => returnHumanControl(asId(requestId)), () => false)
  const submit = async (args: unknown[], queueWhenBusy = false): Promise<boolean> => {
    const [sessionId, text, attachments] = args
    const id = asId(sessionId)
    traceChatTiming(id, 'submit-received')
    const body = asString(text)
    const files = asAttachments(attachments)

    if (!getSession(id)) {
      fail(id, 'That conversation no longer exists.')
      return false
    }

    // Hidden receipt/review turns and a start reservation can be live before
    // the renderer observes a spinner. Accept trusted user input through the
    // same durable queue used by the busy composer; never reject that race or
    // mark the hidden run done. Native callers keep their busy=false contract.
    if (isRunning(id) || isStarting(id) || isQueueDraining(id) || hasPendingQueueWrite(id) || getMessageQueue(id).items.length) {
      return queueWhenBusy ? Boolean(await enqueue(args)) : false
    }
    reserveStart(id)
    try {
      const send = await loopFn('sendMessage')
      if (!send) {
        fail(id, AGENT_UNAVAILABLE)
        return false
      }
      if (isStartCancelled(id)) return false
      if (isRunning(id)) return queueWhenBusy ? Boolean(await enqueue(args)) : false
      unsuspendQueue(id)
      return startTurn(() => send(id, body, files), (err) => {
        console.error('[openbot/ipc] agent.send failed', err)
        fail(id, err instanceof Error ? err.message : 'The agent run failed.')
      })
    } finally {
      releaseStart(id)
      void drainQueue(id)
    }
  }
  const send: Handler<boolean> = args => submit(args)
  registerNativeHandler(CHANNELS.agentSend, send)
  handleEvent<boolean>(CHANNELS.agentSend, async (event, args) => {
    const id = asId(args[0]), body = asString(args[1]), files = asAttachments(args[2])
    const intent = await consumeGmailUserIntent(event.sender.id, id, body, files)
    if (!intent.consumed) return submit(args, true)
    finishLocalUserIntent(id)
    return intent.accepted
  }, () => false)

  handle<boolean>(CHANNELS.agentStop, async ([sessionId, message]) => {
    const id = asId(sessionId)
    cancelStart(id)
    suspendQueue(id)
    try {
      await pauseQueueIfNeeded(id)
      announceQueue(id)
    } catch (error) {
      console.error('[openbot/queue] could not persist pause', error)
    }
    const stop = await loopFn('stopSession')
    if (!stop) return false
    try {
      await stop(id)
      const children = listTasks().filter((task) => task.sourceSessionId === id && (task.status === 'queued' || task.status === 'running'))
      for (const task of children) await cancelBackgroundTask(task.id)
      if (typeof message === 'string' && message.trim()) {
        const session = await sessions.get(id)
        if (session) {
          await addUserMessage(session, asString(message), undefined, false)
          await addNotice(session, getBot(session.activeBotId), getSettings().language === 'en' ? 'Stop requested. Some actions may already have happened.' : '已发送停止请求，部分操作可能已经执行。')
        }
      }
      return true
    } catch (err) {
      console.error('[openbot/ipc] agent.stop failed', err)
      return false
    }
  }, () => false)

  handleVoid(CHANNELS.agentRespondToApproval, async ([requestId, decision]) => {
    const id = asId(requestId)
    const choice = asDecision(decision)
    const respond = await loopFn('respondToApproval')
    if (!respond) {
      console.warn('[openbot/ipc] approval dropped, agent runtime unavailable:', id)
      return
    }
    await respond(id, choice)
  })
}
