import type { AgentEvent, Message, Session } from '../../../shared/types'
import { mergeAgentMessages } from './agentTaskPresentation'

export interface AgentSessionSnapshot {
  phase: 'loading' | 'ready' | 'missing' | 'unavailable' | 'error'
  messages: Message[]
  liveUnavailable: boolean
  activityVersion?: number
}
export interface AgentSessionReadApi {
  get(id: string): Promise<Session | null>
  live(id: string): Promise<Message[]>
  on(listener: (event: AgentEvent) => void): () => void
  watch?(id: string | null): Promise<void>
}

/** A read-only subscription. Events trigger coalesced snapshots, never a replay
 * of deltas which might already be included in the runtime snapshot. */
export function observeAgentSession(api: AgentSessionReadApi, sessionId: string, botId: string, changed: (state: AgentSessionSnapshot) => void) {
  let active = true, inFlight = false, dirty = false, savedDirty = true, activityVersion = 0
  let savedSession: Session | null = null
  let liveActivity = ''
  let state: AgentSessionSnapshot = { phase: 'loading', messages: [], liveUnavailable: false }
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let polling: ReturnType<typeof setInterval> | undefined
  let watching: boolean | undefined
  let watched = api.watch?.(sessionId) ?? Promise.resolve(), watchFailed = false
  const publish = (next: AgentSessionSnapshot): void => { if (active) { state = next; changed(next) } }
  const refresh = async (): Promise<void> => {
    if (!active) return
    if (inFlight) { dirty = true; return }
    inFlight = true
    const readSaved = savedDirty
    savedDirty = false
    try { await watched } catch { watchFailed = true; savedDirty = true; if (active) publish({ ...state, phase: 'error' }); inFlight = false; return }
    if (!active) { inFlight = false; return }
    // A text token needs only the small live buffer, never the whole history.
    const [saved, live] = await Promise.allSettled([readSaved ? api.get(sessionId) : Promise.resolve(savedSession), api.live(sessionId)])
    if (active) {
      if (saved.status === 'rejected') { savedDirty = true; publish({ ...state, phase: 'error' }) }
      else if (!saved.value) { savedSession = null; publish({ phase: 'missing', messages: [], liveUnavailable: false }) }
      else if (saved.value.id !== sessionId || !saved.value.botIds.includes(botId)) { savedSession = null; publish({ phase: 'unavailable', messages: [], liveUnavailable: false }) }
      else {
        const signature = live.status === 'fulfilled' ? JSON.stringify(live.value.map(message => [message.id, message.toolCalls, message.toolResult, message.agentTrace])) : liveActivity
        if (signature !== liveActivity) { liveActivity = signature; activityVersion++ }
        if (readSaved) {
          const previous = new Map(savedSession?.messages.map(message => [message.id, message]))
          savedSession = { ...saved.value, messages: saved.value.messages.map(message => {
            const old = previous.get(message.id)
            return old && JSON.stringify(old) === JSON.stringify(message) ? old : message
          }) }
        }
        publish({ phase: 'ready', messages: mergeAgentMessages(savedSession!.messages, live.status === 'fulfilled' ? live.value : []), liveUnavailable: live.status === 'rejected', activityVersion })
      }
    }
    inFlight = false
    if (dirty && active) { dirty = false; schedule() }
  }
  const schedule = (): void => {
    if (scheduled || !active) return
    scheduled = setTimeout(() => { scheduled = undefined; void refresh() }, 40)
  }
  const unsubscribe = api.on(event => {
    const id = event.type === 'session-updated' ? event.session.id : event.type === 'session-summary-updated' ? event.summary.id : 'sessionId' in event ? event.sessionId : undefined
    if (id !== sessionId) return
    if (event.type === 'message-updated' || event.type === 'message-removed') {
      savedDirty = true; activityVersion++; schedule()
    } else if (['message-end', 'session-updated', 'session-summary-updated', 'done', 'error'].includes(event.type)) {
      savedDirty = true; activityVersion++; schedule()
    } else if (['message-start', 'text-delta', 'reasoning-delta', 'agent-trace', 'tool-call', 'tool-result'].includes(event.type)) {
      if (event.type !== 'text-delta' && event.type !== 'reasoning-delta') activityVersion++
      schedule()
    }
  })
  publish(state)
  void refresh()
  return {
    refresh: () => {
      if (watchFailed) { watchFailed = false; watched = api.watch?.(sessionId) ?? Promise.resolve() }
      savedDirty = true; activityVersion++; void refresh()
    },
    setRunning(value: boolean): void {
      if (!active) return
      // Task status can be the only final signal (for example cancellation of
      // a continuation). Read the final saved checkpoint when watching ends.
      if (watching !== undefined && watching !== value) { savedDirty = true; activityVersion++; schedule() }
      watching = value
      if (polling) clearInterval(polling)
      // Recovery for a lost checkpoint/terminal event, not token polling.
      polling = value ? setInterval(() => { savedDirty = true; activityVersion++; schedule() }, 5000) : undefined
    },
    dispose(): void {
      active = false; unsubscribe()
      void api.watch?.(null).catch(() => {})
      if (scheduled) clearTimeout(scheduled)
      if (polling) clearInterval(polling)
    }
  }
}
