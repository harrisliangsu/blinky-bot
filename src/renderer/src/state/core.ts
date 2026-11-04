import type { Message, ToolResult } from '../../../shared/types'
import { initialState, type AppState, type ModalName } from './types'

type Listener = () => void

/**
 * The state container.
 *
 * Two independent notification channels:
 *  - the app snapshot, for structural changes (sessions, bots, settings…)
 *  - one channel per message, so a streaming token wakes a single bubble
 *    rather than the whole transcript.
 */
class StateCore {
  private state: AppState = initialState
  private listeners = new Set<Listener>()

  private messages = new Map<string, Message>()
  private messageListeners = new Map<string, Set<Listener>>()
  private results = new Map<string, ToolResult>()

  private pending = new Map<string, { text: string; reasoning: string }>()
  private frame: number | null = null
  private toastTimer: number | null = null
  private seq = 0

  /** Ids of locally echoed user messages awaiting reconciliation. */
  readonly optimistic = new Set<string>()

  /* — snapshot — */

  getState = (): AppState => this.state

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  /** @internal — action modules only. */
  patch(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next }
    for (const l of this.listeners) l()
  }

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  /* — message registry — */

  getMessage = (id: string): Message | undefined => this.messages.get(id)

  subscribeMessage = (id: string, l: Listener): (() => void) => {
    let set = this.messageListeners.get(id)
    if (!set) {
      set = new Set()
      this.messageListeners.set(id, set)
    }
    set.add(l)
    return () => {
      const current = this.messageListeners.get(id)
      if (!current) return
      current.delete(l)
      if (current.size === 0) this.messageListeners.delete(id)
    }
  }

  notifyMessage(id: string): void {
    const set = this.messageListeners.get(id)
    if (!set) return
    for (const l of set) l()
  }

  hasMessage(id: string): boolean {
    return this.messages.has(id)
  }

  putMessage(msg: Message): void {
    this.messages.set(msg.id, msg)
    this.notifyMessage(msg.id)
  }

  /** Adds a message and appends it to the visible order. */
  appendMessage(msg: Message): void {
    this.messages.set(msg.id, msg)
    this.patch({ messageIds: [...this.state.messageIds, msg.id] })
  }

  patchMessage(id: string, next: Partial<Message>): void {
    const prev = this.messages.get(id)
    if (!prev) return
    this.messages.set(id, { ...prev, ...next })
    this.notifyMessage(id)
  }

  dropMessage(id: string): void {
    this.messages.delete(id)
    this.pending.delete(id)
    // Listeners survive, as they do across `resetMessages`: a bubble that is
    // still mounted must keep its channel, and unsubscribing prunes the entry.
    this.notifyMessage(id)
    this.patch({ messageIds: this.state.messageIds.filter((x) => x !== id) })
  }

  /**
   * Swaps the whole message set (session switch, or a full session snapshot).
   * Listeners are deliberately left in place — a bubble that survives the swap
   * is still mounted and must keep receiving its updates.
   */
  resetMessages(list: Message[]): string[] {
    this.messages.clear()
    this.results.clear()
    this.optimistic.clear()
    this.pending.clear()
    const ids: string[] = []
    for (const m of list) {
      this.messages.set(m.id, m)
      ids.push(m.id)
      if (m.toolResult) this.results.set(m.toolResult.callId, m.toolResult)
    }
    for (const id of this.messageListeners.keys()) this.notifyMessage(id)
    return ids
  }

  /* — tool results — */

  getToolResult = (callId: string): ToolResult | undefined => this.results.get(callId)

  setToolResult(result: ToolResult): void {
    this.results.set(result.callId, result)
  }

  /** Wakes any bubble that owns the originating call. */
  notifyCallOwners(callId: string): void {
    for (const id of this.state.messageIds) {
      if (this.messages.get(id)?.toolCalls?.some((c) => c.id === callId)) this.notifyMessage(id)
    }
  }

  /* — streaming deltas, batched to one frame — */

  queueDelta(messageId: string, field: 'text' | 'reasoning', delta: string): void {
    if (!this.messages.has(messageId)) return
    const prev = this.messages.get(messageId)
    const entry = this.pending.get(messageId) ?? { text: '', reasoning: '' }
    entry[field] += delta
    this.pending.set(messageId, entry)
    /*
     * The first token paints now. Waiting for the next animation frame on top
     * of the CLI's line buffer is a second queue in front of an empty bubble,
     * and it is the one the user actually feels. Later tokens still batch to
     * a frame so a fast stream does not re-render per character.
     */
    if (!prev?.content && !prev?.reasoning) {
      this.flushNow()
      return
    }
    if (this.frame === null) {
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null
        this.flush()
      })
    }
  }

  private flush(): void {
    if (this.pending.size === 0) return
    const batch = this.pending
    this.pending = new Map()
    for (const [id, delta] of batch) {
      const prev = this.messages.get(id)
      if (!prev) continue
      const next: Message = { ...prev, streaming: true }
      if (delta.text) next.content = prev.content + delta.text
      if (delta.reasoning) next.reasoning = (prev.reasoning ?? '') + delta.reasoning
      this.messages.set(id, next)
      this.notifyMessage(id)
    }
  }

  /** Drains buffered deltas immediately — used before any ordering-sensitive event. */
  flushNow(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.flush()
  }

  endAllStreaming(): void {
    this.flushNow()
    // The whole registry, not just the visible order: a message can outlive its
    // place in `messageIds` and would otherwise keep a live caret forever.
    for (const [id, msg] of this.messages) {
      if (msg.streaming) this.patchMessage(id, { streaming: false })
    }
    this.patch({ streaming: false })
  }

  /* — transient UI — */

  setModal(modal: ModalName, botDraftId: string | null = null): void {
    this.patch({ modal, botDraftId: modal === 'bots' ? botDraftId : null })
  }

  toggleRail(): void {
    this.patch({ railOpen: !this.state.railOpen })
  }

  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.patch({ toast: { text, kind } })
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.patch({ toast: null }), 5000)
  }

  dismissToast(): void {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    this.patch({ toast: null })
  }

  clearRunError(): void {
    this.patch({ runError: null })
  }
}

export const store = new StateCore()
export type { StateCore }
