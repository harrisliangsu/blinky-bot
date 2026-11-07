import { isRunning } from '../agent/cancel'
import { onAgentEvent } from '../agent/events'
import { isQueueDraining } from '../agent/messageQueueRuntime'
import { hasPendingQueueWrite, isStarting, releaseStart, reserveStart } from '../agent/startReservation'
import { loopFn } from '../ipc/agentRuntime'
import { getMessageQueue } from '../store/messageQueue'
import { getSession } from '../store/sessions'
import { pendingXFeedback, setXFeedback } from './xDrafts'

const active = new Set<string>()
let installed = false

/** Each receipt wakes only the originating lead; uncertain deliveries are not replayed. */
export function installXDraftInbox(): void {
  if (installed) return
  installed = true
  onAgentEvent((event) => {
    if (event.type === 'x-draft-updated' && event.draft.feedbackStatus === 'pending') void drain(event.draft.sessionId)
    else if (event.type === 'done') void drain(event.sessionId)
    else if (event.type === 'session-updated') void drain(event.session.id)
    else if (event.type === 'message-queue-updated' && !event.queue.items.length) void drain(event.queue.sessionId)
  })
  void pendingXFeedback().then((items) => { for (const sessionId of new Set(items.map((d) => d.sessionId))) void drain(sessionId) }).catch(() => console.error('[x drafts] unable to load pending receipts'))
}

async function drain(sessionId: string): Promise<void> {
  if (active.has(sessionId)) return
  active.add(sessionId)
  let reserved = false, completed = false, claimed: string | undefined
  try {
    const draft = (await pendingXFeedback()).find((item) => item.sessionId === sessionId)
    const session = getSession(sessionId)
    if (!draft || !session || session.archived || session.activeBotId !== draft.receiverBotId) return
    if (isRunning(sessionId) || isStarting(sessionId) || isQueueDraining(sessionId) || hasPendingQueueWrite(sessionId) || getMessageQueue(sessionId).items.length) return
    reserveStart(sessionId); reserved = true
    const receive = await loopFn('receiveXDraftResult'); if (!receive) return
    const record = await setXFeedback(draft.id, 'pending', 'delivering'); if (!record) return
    claimed = draft.id; await receive(record); await setXFeedback(draft.id, 'delivering', 'delivered')
    claimed = undefined; completed = true
  } catch {
    if (claimed) completed = Boolean(await setXFeedback(claimed, 'delivering', 'uncertain').catch(() => null))
    console.error('[x drafts] receipt delivery was not confirmed')
  } finally {
    if (reserved) releaseStart(sessionId)
    active.delete(sessionId)
    if (completed) void drain(sessionId)
  }
}
