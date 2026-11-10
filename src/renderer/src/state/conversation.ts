import type { ApprovalDecision, Attachment, Message } from '../../../shared/types'
import { bridge, errText } from './bridge'
import { store } from './core'
import { dropApprovals } from './events'
import { adoptSession, loadSessions } from './sessions'

/*
 * A send that has to create the session first is guarded here, not only by the
 * composer's `canSend`.
 *
 * `canSend` is derived from `streaming`, and `streaming` was only raised AFTER
 * the `sessions.create()` round trip — so nothing was armed while it was in
 * flight. Two quick Enters on first launch (or after the last chat was deleted)
 * created two sessions and sent the turn twice. The flag is released the moment
 * that round trip ends, on every path: holding it across `agent.send` would
 * cover the whole run and leave the composer dead if a run never terminated.
 */
let creatingSession = false

/**
 * Sends a turn, echoing the user bubble locally so typing feels instant.
 *
 * Resolves false when the text never reached the agent, so the composer can
 * hand it back instead of swallowing what the user typed.
 */
export async function sendTurn(text: string, attachments?: Attachment[]): Promise<boolean> {
  const body = text.trim()
  if (!body && !attachments?.length) return false

  let sessionId = store.getState().currentSessionId
  if (!sessionId) {
    if (creatingSession) return false
    creatingSession = true
    // Arm the composer's guard BEFORE the round trip rather than after it.
    store.patch({ streaming: true, runError: null })
    try {
      const session = await bridge().sessions.create()
      adoptSession(session)
      sessionId = session.id
      void loadSessions()
    } catch (e) {
      // Every failure path releases what the guard armed, or the composer would
      // stay stuck in a run that never started.
      store.patch({ streaming: false })
      store.toast(errText(e), 'error')
      return false
    } finally {
      creatingSession = false
    }
  }

  const local: Message = {
    id: store.nextId('local'),
    role: 'user',
    content: body,
    attachments,
    createdAt: Date.now()
  }
  store.optimistic.add(local.id)
  store.appendMessage(local)
  const state = store.getState()
  const activeBot = state.bots.find((bot) => bot.id === state.session?.activeBotId)
  const hasPrivateScreen = Boolean(activeBot && activeBot.computerTarget.kind !== 'local')
  // A private computer should be visible as soon as its run starts. The user
  // can still close the Activity rail afterwards; this only makes the start of
  // a new run observable instead of hiding it behind a forgotten panel toggle.
  store.patch({
    streaming: true,
    runError: null,
    railOpen: state.railOpen || hasPrivateScreen
  })

  try {
    const accepted = await bridge().agent.send(sessionId, body, attachments)
    if (!accepted) throw new Error('The conversation is busy or the agent is unavailable.')
    return true
  } catch (e) {
    /*
     * The echo goes with the failure. It used to stay in `messageIds` AND in
     * `store.optimistic`, so the transcript showed a message that was never
     * sent and is not on disk — and because `reconcileOptimistic` matches by
     * trimmed content in insertion order, retyping the same text later retired
     * the STALE echo instead of the new one and both bubbles rendered until the
     * next session snapshot. Only claim it while it is still ours: a real
     * message-start may already have reconciled it.
     */
    if (store.optimistic.delete(local.id)) store.dropMessage(local.id)
    const stillRunning = await bridge().agent.isRunning(sessionId).catch(() => false)
    if (store.getState().currentSessionId === sessionId) {
      store.patch({ streaming: stillRunning, runError: `That message was not sent — ${errText(e)}` })
    }
    return false
  }
}

export async function stopTurn(message?: string): Promise<boolean> {
  const id = store.getState().currentSessionId
  if (!id) return true
  try {
    const stopped = await bridge().agent.stop(id, message)
    if (!stopped) throw new Error('The stop request did not reach the agent.')
    if (store.getState().currentSessionId === id) store.endAllStreaming()
    // Stopping rejects anything still waiting on the user, so the gate must go
    // with the run rather than linger and take a click that means nothing.
    dropApprovals(id)
    return true
  } catch (e) {
    store.toast(errText(e), 'error')
    // Keep the UI in its running state when the main process did not confirm a
    // stop. Pretending the bot is idle here would make human takeover unsafe.
    return false
  }
}

export async function respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
  const { approvals } = store.getState()
  // Kept so the card can be put back: the answer is sent optimistically, and a
  // send that never arrived must not look like one that did.
  const request = approvals.find((a) => a.id === requestId)
  store.patch({ approvals: approvals.filter((a) => a.id !== requestId) })
  try {
    await bridge().agent.respondToApproval(requestId, decision)
  } catch (e) {
    store.toast(errText(e), 'error')
    /*
     * Put the request back where it was.
     *
     * The card came off screen before the IPC call was awaited, so a failed
     * send — a dead bridge, a main process still coming up — left the user with
     * a toast and nothing to click: the decision they made was never delivered,
     * and the agent then sat on the far side of the gate for the whole
     * APPROVAL_TIMEOUT_MS (5 minutes) before the timeout rejected it for them.
     * At the head, because this is the request that was on screen.
     *
     * Only if nothing has re-queued it in the meantime: `applyEvent` dedupes a
     * re-delivered `approval-request` by id, and this must not defeat that.
     */
    const current = store.getState().approvals
    if (request && !current.some((a) => a.id === requestId)) {
      store.patch({ approvals: [request, ...current] })
    }
  }
}

/** Return a private screen to a turn paused inside request_help. */
export async function returnControl(requestId: string): Promise<boolean> {
  try {
    const returned = await bridge().agent.returnControl(requestId)
    if (!returned) store.toast('That help request is no longer waiting.', 'error')
    return returned
  } catch (e) {
    store.toast(errText(e), 'error')
    return false
  }
}

export async function reactToMessage(messageId: string, emoji: string): Promise<void> {
  const sessionId = store.getState().currentSessionId
  if (!sessionId) return
  try { await bridge().sessions.react(sessionId, messageId, emoji) }
  catch (error) { store.toast(errText(error), 'error') }
}
