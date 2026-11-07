import type { AgentEvent, Message, Session, SessionSummary } from '../../../shared/types'
import { noteFrame, notePointer } from './computer'
import { store } from './core'
import { mergeSummary, mergeSessionSummary } from './sessionSummary'
import { summariseTask } from '../../../shared/activity'
import { adoptSession, loadSessions } from './sessions'
import { withPendingSettings } from './preferences'

const isCurrent = (sessionId: string): boolean => store.getState().currentSessionId === sessionId
const loadingEvents = new Map<string, AgentEvent[]>()

/** Replay events received while loading a conversation after its live snapshot. */
export function replayLoadingEvents(sessionId: string): void {
  const events = loadingEvents.get(sessionId) ?? []
  loadingEvents.delete(sessionId)
  for (const event of events) applyEvent(event)
}

export function discardLoadingEvents(sessionId: string): void { loadingEvents.delete(sessionId) }

/*
 * Must carry EVERY field the sidebar filters on. `projectId` was missing, so
 * any `session-updated` event rebuilt the summary without it and the chat
 * silently vanished from its project — the filing was correct on disk the
 * whole time.
 */

/** Removes the local echo that the incoming real user message supersedes. */
function reconcileOptimistic(msg: Message): void {
  if (msg.role !== 'user' || store.optimistic.size === 0) return
  for (const localId of store.optimistic) {
    const local = store.getMessage(localId)
    if (local && local.content.trim() === msg.content.trim()) {
      store.optimistic.delete(localId)
      store.dropMessage(localId)
      return
    }
  }
}

/**
 * Drops approval gates belonging to a turn that has ended.
 *
 * The agent process rejects anything still pending when a run stops, so the
 * dialog on screen is already dead — and a dead dialog that still takes a click
 * tells the user they approved something that will never run. Only this
 * session's gates go: requests are not session-scoped in the queue.
 */
export function dropApprovals(sessionId: string): void {
  const { approvals } = store.getState()
  const kept = approvals.filter((a) => a.sessionId !== sessionId)
  if (kept.length !== approvals.length) store.patch({ approvals: kept })
}

/** Reduces one event from the agent process into renderer state. */
export function applyEvent(event: AgentEvent): void {
  const target = event.type === 'session-updated' ? event.session.id : 'sessionId' in event ? event.sessionId : undefined
  if (target && isCurrent(target) && store.getState().sessionLoading && ['session-updated', 'message-start', 'message-updated', 'message-removed', 'text-delta', 'reasoning-delta', 'tool-call', 'tool-result', 'message-end', 'run-started', 'done', 'error'].includes(event.type)) {
    const events = loadingEvents.get(target) ?? []
    events.push(event)
    loadingEvents.set(target, events)
    return
  }
  switch (event.type) {
    case 'room-devices-changed':
    case 'workspace-updated': return
    case 'session-summary-updated':
      mergeSessionSummary(event.summary)
      return
    case 'run-started':
      if (isCurrent(event.sessionId)) store.patch({ streaming: true, runError: null })
      return
    case 'message-queue-updated':
      // The composer subscribes directly so the queue is scoped to its Bot.
      return
    case 'session-updated': {
      mergeSummary(event.session)
      if (isCurrent(event.session.id)) {
        store.flushNow()
        adoptSession(event.session, true)
      }
      return
    }

    case 'message-updated': {
      if (!isCurrent(event.sessionId)) return
      reconcileOptimistic(event.message)
      if (store.hasMessage(event.message.id)) store.patchMessage(event.message.id, event.message)
      else store.appendMessage(event.message)
      if (event.moveToEnd) store.moveMessageToEnd(event.message.id)
      if (event.message.streaming) store.patch({ streaming: true })
      return
    }
    case 'message-removed':
      if (isCurrent(event.sessionId)) store.dropMessage(event.messageId)
      return

    case 'message-start': {
      if (!isCurrent(event.sessionId)) return
      reconcileOptimistic(event.message)
      // A snapshot may already carry this turn — appending again would put a
      // duplicate id in the visible order.
      if (!store.hasMessage(event.message.id)) store.appendMessage(event.message)
      if (event.message.streaming) store.patch({ streaming: true })
      return
    }

    case 'text-delta':
      if (isCurrent(event.sessionId)) {
        store.queueDelta(event.messageId, 'text', event.delta, event.segment)
        if (event.segment) store.moveMessageToEnd(event.messageId)
      }
      return

    case 'reasoning-delta':
      if (isCurrent(event.sessionId)) store.queueDelta(event.messageId, 'reasoning', event.delta)
      return

    case 'agent-trace':
      // Executor-only details are read by its separate transcript viewer.
      return

    case 'backend-notice':
      // Retry/fallback is implementation progress; terminal failures still
      // arrive as error events. Surface only actionable warnings here.
      if (isCurrent(event.sessionId) && event.category === 'warning') store.toast(event.message, 'info')
      return

    case 'tool-call': {
      if (!isCurrent(event.sessionId)) return
      store.flushNow()
      const owner = store.getMessage(event.messageId)
      if (owner) {
        const calls = owner.toolCalls ?? []
        if (!calls.some((c) => c.id === event.call.id)) {
          store.patchMessage(event.messageId, { toolCalls: [...calls, event.call] })
        }
      }
      notePointer(event.call.name, event.call.args)
      return
    }

    case 'tool-result': {
      if (!isCurrent(event.sessionId)) return
      store.flushNow()
      store.setToolResult(event.result)
      if (store.hasMessage(event.messageId)) store.patchMessage(event.messageId, { toolResult: event.result })
      else store.notifyCallOwners(event.result.callId)
      if (event.result.screenshot) noteFrame(event.result.screenshot)
      return
    }

    case 'message-end': {
      if (!isCurrent(event.sessionId)) return
      store.flushNow()
      // Adopt the committed text: the stream carried the multi-bot ACTION line,
      // which is protocol and must never be shown.
      store.patchMessage(event.messageId, {
        streaming: false,
        ...(event.content !== undefined ? { content: event.content } : {}),
        displayContent: event.displayContent,
        segments: event.segments,
        toolCalls: event.toolCalls,
        error: event.error,
        internal: event.internal
      })
      if (store.getMessage(event.messageId)?.role === 'assistant') store.moveMessageToEnd(event.messageId)
      /*
       * This message ending is not the run ending. A tool call is committed
       * before its approval/execution, and another model turn follows the tool
       * result. Clearing the global flag here made the composer look idle and
       * allowed a second send while the first run was still waiting. `done`
       * (or `error`) is the only terminal boundary for the run itself.
       */
      return
    }

    case 'todos':
      if (isCurrent(event.sessionId)) {
        store.patch({ todos: event.todos })
      }
      return

    case 'token-usage':
      if (isCurrent(event.sessionId)) {
        // Merge rather than replace: reports are partial, and a later one that
        // only carries output tokens must not blank the meter. `adoptSession`
        // clears usage, so nothing survives a session switch.
        const prev = store.getState().usage
        const next = event.usage
        store.patch({
          usage: {
            inputTokens: next.inputTokens ?? prev?.inputTokens,
            outputTokens: next.outputTokens ?? prev?.outputTokens,
            totalTokens: next.totalTokens ?? prev?.totalTokens,
            cachedInputTokens: next.cachedInputTokens ?? prev?.cachedInputTokens,
            contextWindow: event.contextWindow ?? prev?.contextWindow
          }
        })
      }
      return

    case 'approval-resolved': {
      store.patch({ approvals: store.getState().approvals.filter((a) => a.id !== event.requestId) })
      break
    }
    case 'approval-request': {
      // A re-delivered request must not queue twice: the count behind the
      // dialog is what tells the user how much is still waiting on them.
      const { approvals } = store.getState()
      if (!approvals.some((a) => a.id === event.request.id)) {
        store.patch({ approvals: [...approvals, event.request] })
      }
      return
    }

    case 'handoff': {
      if (!isCurrent(event.sessionId)) return
      store.flushNow()
      store.appendMessage({
        id: store.nextId('handoff'),
        role: 'system',
        content: event.reason,
        botId: event.fromBotId,
        handoffTo: event.toBotId,
        createdAt: Date.now()
      })
      const session = store.getState().session
      if (session) store.patch({ session: { ...session, activeBotId: event.toBotId } })
      return
    }

    case 'human-help-request': {
      const current = store.getState().helpRequests
      if (!current.some((request) => request.id === event.request.id)) {
        store.patch({ helpRequests: [...current, event.request], railOpen: true })
      }
      return
    }

    case 'human-help-resolved':
      store.patch({ helpRequests: store.getState().helpRequests.filter((request) => request.id !== event.requestId) })
      return

    case 'activity-updated': {
      const current = store.getState().activity
      store.patch({ activity: [event.item, ...current.filter((item) => item.id !== event.item.id)] })
      return
    }

    case 'task-updated':
    case 'task-summary-updated': {
      const current = store.getState().tasks
      const task = event.type === 'task-updated' ? summariseTask(event.task) : event.task
      store.patch({ tasks: [task, ...current.filter((item) => item.id !== task.id)].sort((a, b) => b.updatedAt - a.updatedAt) })
      return
    }

    case 'routine-updated': {
      const current = store.getState().routines
      store.patch({ routines: [event.routine, ...current.filter((item) => item.id !== event.routine.id)] })
      return
    }

    case 'memory-updated': {
      const { memories } = store.getState()
      const list = memories[event.botId]
      // No list means this bot's memory has never been opened; seeding it from
      // one event would show a single entry as though it were the whole memory.
      if (!list) return
      /*
       * Every writer broadcasts, including the one the editor called itself —
       * `addMemory` prepends the entry the IPC reply hands back, and the main
       * process broadcasts that very same entry a moment later. Without this a
       * fact typed into the memory panel was listed twice, two rows carrying
       * one id, so forgetting either removed both and only a reload settled it.
       */
      if (list.some((entry) => entry.id === event.entry.id)) return
      store.patch({ memories: { ...memories, [event.botId]: [event.entry, ...list] } })
      return
    }

    case 'recording-state': {
      const recording = store.getState().recording
      const restarted = event.state === 'recording' && event.stepCount === 0
      store.patch({
        recording: {
          ...recording,
          state: event.state,
          stepCount: event.stepCount,
          steps: restarted ? [] : recording.steps
        }
      })
      return
    }

    case 'recording-step': {
      const recording = store.getState().recording
      const steps = [...recording.steps, event.step]
      store.patch({ recording: { ...recording, steps, stepCount: steps.length } })
      return
    }

    case 'computer-frame':
      if (isCurrent(event.sessionId)) noteFrame(event.screenshot)
      return

    case 'settings-updated':
      // Settings the main process changed on its own — an "always allow" rule
      // the agent persisted. Adopting them keeps the permissions panel from
      // writing back a list that no longer reflects disk.
      store.patch({ settings: withPendingSettings(event.settings) })
      break

    case 'task-clarification-updated':
    case 'send-rules-updated':
      // Conversation-local cards subscribe directly and reconcile persisted state.
      break
    case 'github-draft-updated':
    case 'gmail-draft-updated':
    case 'calendar-draft-updated':
    case 'x-draft-updated':
    case 'slack-draft-updated':
      // The transcript subscribes directly so drafts stay scoped to their chat.
      return

    case 'backends-updated':
      store.patch({ backends: event.backends, backendsLoading: false, backendsError: null })
      return

    case 'error':
      dropApprovals(event.sessionId)
      if (isCurrent(event.sessionId)) {
        // Clear the carets too: a failed turn often never reaches `done`, and a
        // bubble left mid-stream reads as though the run is still going.
        store.endAllStreaming()
        store.patch({ runError: event.message })
      } else {
        store.flushNow()
        store.toast(event.message, 'error')
      }
      return

    case 'done':
      dropApprovals(event.sessionId)
      if (isCurrent(event.sessionId)) store.endAllStreaming()
      void loadSessions()
      return

    default: {
      // Exhaustiveness: a new AgentEvent variant must fail the build here
      // rather than be dropped on the floor at runtime.
      const unhandled: never = event
      void unhandled
      return
    }
  }
}
