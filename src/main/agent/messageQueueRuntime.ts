import { isRunning, supersedeForFollowup } from './cancel'
import { isStarting } from './startReservation'
import { broadcast, onAgentEvent } from './events'
import { sendMessage } from './loop'
import { deferQueuedMessage, finishQueuedMessage, getMessageQueue, markQueuedMessageRecorded, removeQueuedMessage, returnQueuedMessage, setQueuePaused, startQueuedMessage } from '../store/messageQueue'
import { getSession, isSessionMessageDurable } from '../store/sessions'
import { getBot } from '../store/bots'
import { steerCodexTurn } from '../backends/cli/codexAppServer'
import { sessions } from './sessionGateway'
import { addNotice, addUserMessage } from './messages'
import { toProviderMessages } from './history'
import { flushAll } from '../store/jsonStore'
import { getSettings } from '../settings'
import { resolveBotBinding } from '../../shared/botBinding'
import { prepareWebhookRoutineRun } from '../routines/webhookRuns'

/** Persist a never-started Webhook cancellation before removing its receipt. */
export async function removeQueuedItem(sessionId: string, itemId: string) {
  const initial = getMessageQueue(sessionId), item = initial.items.find(value => value.id === itemId)
  if (!item || !item.id.startsWith('webhook-')) return removeQueuedMessage(sessionId, itemId)
  if (item.status === 'running' || item.status === 'processing') throw new Error('Cannot remove a message while it is running.')
  const wasSuspended = isQueueSuspended(sessionId)
  if (!wasSuspended) suspendQueue(sessionId)
  const generation = queueSuspensionGeneration(sessionId)
  await setQueuePaused(sessionId, true)
  const current = getMessageQueue(sessionId).items.find(value => value.id === itemId)
  if (current?.status === 'running' || current?.status === 'processing') throw new Error('The message is being delivered; stop it before removing it.')
  const hook = await prepareWebhookRoutineRun(sessionId, item.id, item.targetBotId)
  try {
    await hook?.settle({ status: 'cancelled', error: '用户取消了尚未执行的 Webhook 队列任务。' })
    const queue = await removeQueuedMessage(sessionId, itemId)
    if (!wasSuspended && queueSuspensionGeneration(sessionId) === generation) {
      if (!initial.paused && !queue.items.some(value => value.status === 'interrupted')) await setQueuePaused(sessionId, false)
      unsuspendQueue(sessionId)
    }
    announceQueue(sessionId)
    void drainQueue(sessionId)
    return getMessageQueue(sessionId)
  } finally { hook?.release() }
}

const draining = new Set<string>()
const executing = new Set<string>()
const failed = new Set<string>()
const suspended = new Set<string>()
const suspensionGeneration = new Map<string, number>()
let installed = false
const retries = new Map<string, ReturnType<typeof setTimeout>>()
const interruptedForFollowup = new Set<string>()
/** Steer receipts whose RPC failed mid-turn; verified against the transcript when the turn ends. */
const uncertainSteers = new Map<string, Set<string>>()
/** Consecutive live-steer rejections; the turn-end drain is the real fallback. */
const steerRetries = new Map<string, number>()
const STEER_RETRY_LIMIT = 25

function retryDelivery(sessionId: string): void {
  if (retries.has(sessionId)) return
  const timer = setTimeout(() => { retries.delete(sessionId); void drainQueue(sessionId) }, 400)
  retries.set(sessionId, timer)
}

/** Decide steers that timed out mid-turn: an ack records the message with the
 * receipt id, so transcript presence proves delivery; absence makes a
 * fresh-turn redelivery through the queue safe. */
async function reconcileUncertainSteers(sessionId: string): Promise<void> {
  const pending = uncertainSteers.get(sessionId)
  if (!pending?.size) return
  const session = await sessions.get(sessionId)
  if (!session) { uncertainSteers.delete(sessionId); return }
  const messageIds = new Set(session.messages.map((message) => message.id))
  for (const id of [...pending]) {
    if (!messageIds.has(id)) continue
    // The steer reached the CLI; only the acknowledgement was lost.
    pending.delete(id)
    await finishQueuedMessage(sessionId, id, false)
    announceQueue(sessionId)
  }
  if (!pending.size) uncertainSteers.delete(sessionId)
}

/** Do not remove the durable delivery record ahead of the transcript write. */
export async function confirmMessageStored(sessionId: string, messageId: string): Promise<void> {
  const report = await flushAll()
  if (report.stillWriting || !isSessionMessageDurable(sessionId, messageId)) {
    throw new Error('Could not confirm that the sent message was saved.')
  }
}

export function announceQueue(sessionId: string): void {
  broadcast({ type: 'message-queue-updated', queue: getMessageQueue(sessionId) })
}

export function suspendQueue(sessionId: string): void {
  suspended.add(sessionId)
  interruptedForFollowup.delete(sessionId)
  suspensionGeneration.set(sessionId, (suspensionGeneration.get(sessionId) ?? 0) + 1)
}
export function unsuspendQueue(sessionId: string): void { suspended.delete(sessionId) }
export function isQueueSuspended(sessionId: string): boolean { return suspended.has(sessionId) }
export function queueSuspensionGeneration(sessionId: string): number { return suspensionGeneration.get(sessionId) ?? 0 }
export function isQueueDraining(sessionId: string): boolean { return draining.has(sessionId) }
export function isQueueExecuting(sessionId: string): boolean { return executing.has(sessionId) }

/** Continue only after a completed turn. Errors and explicit stop pause the queue. */
export function installQueueRuntime(): void {
  if (installed) return
  installed = true
  onAgentEvent((event) => {
    if (event.type === 'session-updated') { void drainQueue(event.session.id); return }
    if (event.type === 'error') failed.add(event.sessionId)
    if (event.type !== 'done') return
    const wasFailed = failed.delete(event.sessionId)
    if (draining.has(event.sessionId) || executing.has(event.sessionId)) {
      if (wasFailed) failed.add(event.sessionId)
      return
    }
    if (wasFailed && getMessageQueue(event.sessionId).items.length) {
      suspendQueue(event.sessionId)
      void setQueuePaused(event.sessionId, true).then(() => announceQueue(event.sessionId)).catch(console.error)
    } else if (!wasFailed) void drainQueue(event.sessionId)
  })
}

export async function drainQueue(sessionId: string): Promise<void> {
  if (draining.has(sessionId) || suspended.has(sessionId)) return
  await reconcileUncertainSteers(sessionId)
  const initial = getMessageQueue(sessionId)
  // A processing receipt belongs to the active turn. It must not be treated
  // as a new follow-up, or the resumed turn repeatedly interrupts itself.
  if (initial.paused || !initial.items.some((item) => item.status === 'waiting')) return
  const first = initial.items.find((item) => item.status === 'waiting')
  const current = getSession(sessionId)
  if (first?.targetBotId && (!current || current.activeBotId !== first.targetBotId || current.botIds.length !== 1 || current.botIds[0] !== first.targetBotId || isRunning(sessionId))) return
  if (isStarting(sessionId) && !isRunning(sessionId)) { retryDelivery(sessionId); return }
  const running = isRunning(sessionId)
  if (running) {
    const session = getSession(sessionId)
    const bot = session?.activeBotId ? getBot(session.activeBotId) : null
    // Codex supports native live steering. Other backends resume the same
    // conversation after the active turn has stopped and released its state.
    if (!bot) return
    if (resolveBotBinding(bot, getSettings()).backendId !== 'codex') {
      const report = await flushAll()
      if (!report.stillWriting && !report.failed.length && supersedeForFollowup(sessionId)) interruptedForFollowup.add(sessionId)
      else retryDelivery(sessionId)
      return
    }
  }
  draining.add(sessionId)
  try {
    while (!suspended.has(sessionId)) {
      const item = await startQueuedMessage(sessionId, isRunning(sessionId))
      if (!item) break
      announceQueue(sessionId)
      const targetSession = getSession(sessionId)
      if (item.targetBotId && (!targetSession || targetSession.activeBotId !== item.targetBotId || targetSession.botIds.length !== 1 || targetSession.botIds[0] !== item.targetBotId || isRunning(sessionId))) {
        await deferQueuedMessage(sessionId, item.id); announceQueue(sessionId); break
      }
      if (suspended.has(sessionId)) {
        await returnQueuedMessage(sessionId, item.id)
        announceQueue(sessionId)
        break
      }
      if (isRunning(sessionId)) {
        if (!running) {
          await deferQueuedMessage(sessionId, item.id)
          announceQueue(sessionId)
          break
        }
        try {
          let imagesUnavailable = false
          const accepted = await steerCodexTurn(sessionId, item.text, async () => {
            const session = await sessions.get(sessionId)
            if (!session) throw new Error('The conversation no longer exists.')
            await addUserMessage(session, item.text, item.attachments, false, item.id, item.createdAt)
            await confirmMessageStored(sessionId, item.id)
            if (imagesUnavailable) {
              const notice = getSettings().language === 'zh-CN'
                ? '当前模型无法读取图片。图片已保存在对话中；请切换支持图片的模型后重新发送。'
                : 'This model cannot read images. The attachment remains in this conversation; switch to a vision-capable model and send it again.'
              await addNotice(session, null, notice)
            }
          }, (supportsVision) => {
            imagesUnavailable = !supportsVision && item.attachments.some((attachment) => attachment.kind === 'image')
            return toProviderMessages([{
              id: item.id, role: 'user', content: item.text,
              attachments: item.attachments, createdAt: item.createdAt
            }], { supportsVision })[0]!
          })
          if (!accepted) {
            const attempts = (steerRetries.get(sessionId) ?? 0) + 1
            steerRetries.set(sessionId, attempts)
            await deferQueuedMessage(sessionId, item.id)
            announceQueue(sessionId)
            // Polling is only an accelerator; past the cap the active turn's
            // done event drains the queue and delivers as a fresh turn.
            if (attempts < STEER_RETRY_LIMIT) retryDelivery(sessionId)
            break
          }
          steerRetries.delete(sessionId)
          // The live RPC acknowledged actual delivery and the message is durable.
          await finishQueuedMessage(sessionId, item.id, false)
          announceQueue(sessionId)
          continue
        } catch (error) {
          // A timed-out request may already have reached the CLI. Keep the
          // receipt waiting and verify against the transcript when this turn
          // ends; presence confirms delivery, absence redelivers safely.
          await deferQueuedMessage(sessionId, item.id)
          const pending = uncertainSteers.get(sessionId) ?? new Set<string>()
          pending.add(item.id)
          uncertainSteers.set(sessionId, pending)
          announceQueue(sessionId)
          console.error('[openbot/queue] live delivery was not confirmed; verifying after the turn ends', error)
          break
        }
      }
      // sendMessage reserves the run synchronously. Do not keep the delivery
      // lock for the entire task, or later messages cannot reach its live turn.
      const batch = [item]
      // The idle turn consumes all already-waiting messages together. They
      // remain individual durable receipts so a crash is never replayed.
      while (!item.targetBotId && !item.attachments.length && !suspended.has(sessionId)) {
        const waiting = getMessageQueue(sessionId).items.find((candidate) => candidate.status === 'waiting')
        // Some CLI transports only send the last message's images on resume.
        // Keep attachment turns separate until every image can be forwarded.
        if (!waiting || waiting.targetBotId || waiting.attachments.length) break
        const next = await startQueuedMessage(sessionId, true)
        if (!next) break
        batch.push(next)
      }
      if (suspended.has(sessionId)) {
        for (const pending of batch) await returnQueuedMessage(sessionId, pending.id)
        announceQueue(sessionId)
        break
      }
      let hook: Awaited<ReturnType<typeof prepareWebhookRoutineRun>> = null
      try { hook = await prepareWebhookRoutineRun(sessionId, item.id, item.targetBotId) }
      catch (error) {
        await finishQueuedMessage(sessionId, item.id, true)
        announceQueue(sessionId)
        throw error
      }
      if (suspended.has(sessionId) || isRunning(sessionId)) {
        hook?.release()
        for (const pending of batch) {
          if (suspended.has(sessionId)) await returnQueuedMessage(sessionId, pending.id)
          else await deferQueuedMessage(sessionId, pending.id)
        }
        announceQueue(sessionId)
        break
      }
      executing.add(sessionId)
      steerRetries.delete(sessionId)
      let delivered = false
      void sendMessage(sessionId, item.text, item.attachments, {
        id: item.id,
        createdAt: item.createdAt,
        targetBotId: item.targetBotId,
        additional: batch.slice(1),
        resumeAfterInterruption: interruptedForFollowup.delete(sessionId),
        ...(hook ? {
          beforeFirstTurn: (signal: AbortSignal) => hook.start(signal),
          onSettled: async (outcome: import('../routines/webhookRuns').WebhookRunOutcome) => {
            // The loop has already emitted this turn's done/error.
            hook.release()
            await hook.settle(outcome)
          }
        } : {}),
        onRecorded: async () => {
          for (const pending of batch) await confirmMessageStored(sessionId, pending.id)
          for (const pending of batch) await markQueuedMessageRecorded(sessionId, pending.id)
          delivered = true
          announceQueue(sessionId)
        }
      })
        .then(() => failed.delete(sessionId), () => true)
        .then(async (uncertain) => {
          // A confirmed transcript write precedes starting the model. Keep
          // the receipt until the run finishes: a crash in between cannot
          // otherwise distinguish a message that the model never received.
          for (const pending of batch) await finishQueuedMessage(sessionId, pending.id, !delivered || uncertain)
          announceQueue(sessionId)
          if (delivered && uncertain && getMessageQueue(sessionId).items.length) {
            suspendQueue(sessionId)
            await setQueuePaused(sessionId, true)
            announceQueue(sessionId)
          }
        })
        .catch((error) => console.error('[openbot/queue] could not finish delivery', error))
        .finally(() => { hook?.release(); executing.delete(sessionId); void drainQueue(sessionId) })
      retryDelivery(sessionId)
      break
    }
  } catch (error) {
    console.error('[openbot/queue] could not continue', error)
  } finally {
    draining.delete(sessionId)
    // A turn may finish while a live-delivery attempt is in flight.
    const remaining = getMessageQueue(sessionId)
    const next = remaining.items.find((item) => item.status === 'waiting'), session = getSession(sessionId)
    const eligible = !next?.targetBotId || (session?.activeBotId === next.targetBotId && session.botIds.length === 1 && session.botIds[0] === next.targetBotId)
    if (!isRunning(sessionId) && !suspended.has(sessionId) && !remaining.paused && next && eligible) retryDelivery(sessionId)
  }
}
