import { onAgentEvent } from '../agent/events'
import { announceQueue, drainQueue, isQueueSuspended } from '../agent/messageQueueRuntime'
import { beginQueueWrite, endQueueWrite } from '../agent/startReservation'
import { getBot } from '../store/bots'
import { ensureBotHome } from '../store/botHome'
import { flushAll } from '../store/jsonStore'
import { enqueueExternalMessageOnce, getMessageQueue } from '../store/messageQueue'
import { getSession } from '../store/sessions'
import { getRoutine } from '../store/routines'
import { markWebhookQueued, pendingWebhookSignals } from './webhookInbox'

let installed = false, draining = false, again = false
let timer: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined
export function installWebhookDelivery(): void {
  if (installed) return
  installed = true
  unsubscribe = onAgentEvent((event) => { if (event.type === 'done' || event.type === 'session-updated') void drainWebhookInbox() })
  // A transient storage or destination failure must not leave an accepted
  // signal stranded when no other chat activity occurs.
  timer = setInterval(() => void drainWebhookInbox(), 30_000); timer.unref?.()
  void drainWebhookInbox()
}
export function stopWebhookDelivery(): void { if (timer) clearInterval(timer); timer = undefined; unsubscribe?.(); unsubscribe = undefined; installed = false }
export async function drainWebhookInbox(): Promise<void> {
  if (draining) { again = true; return }
  draining = true
  try {
    for (const item of await pendingWebhookSignals()) {
      const routine = getRoutine(item.routineId), bot = getBot(item.botId)
      if (!routine || routine.botId !== item.botId || routine.trigger.kind !== 'webhook' || !bot || bot.archived) continue
      const session = ensureBotHome(item.botId)
      if (!session || session.botIds.length !== 1 || session.botIds[0] !== item.botId || session.activeBotId !== item.botId) continue
      const saved = await flushAll(); if (saved.failed.length || saved.stillWriting) throw new Error('The destination conversation could not be saved.')
      const current = getSession(session.id)
      if (!current || current.archived || current.activeBotId !== item.botId || current.botIds.length !== 1 || current.botIds[0] !== item.botId) continue
      // Only the owner's saved instruction is delivered. Sender-controlled body
      // content is deliberately not interpreted as a user instruction.
      const text = `[Webhook routine: ${item.name}]\n\n${item.instruction}`
      beginQueueWrite(session.id)
      try {
        if (!getSession(session.id)?.messages.some((message) => message.id === item.id) && !getMessageQueue(session.id).items.some((queued) => queued.id === item.id)) await enqueueExternalMessageOnce(session.id, item.id, text, item.botId, isQueueSuspended(session.id))
        await markWebhookQueued(item.id)
        announceQueue(session.id)
      } finally { endQueueWrite(session.id); void drainQueue(session.id) }
    }
  } catch { console.error('[webhook inbox] pending signals could not be delivered safely') }
  finally { draining = false; if (again) { again = false; void drainWebhookInbox() } }
}
