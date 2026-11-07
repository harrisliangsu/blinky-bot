/** The desktop event source drives remote invalidations too. No transcripts in this journal. */
import type { AgentEvent, Message } from '../../shared/types'
import { createHash } from 'node:crypto'
import { publicRoomMessage } from './history'

interface Change { revision: number; move: boolean }
interface Timeline { revision: number; floor: number; changed: Map<string, Change>; moved: Map<string, number>; publicIds: Set<string>; streaming: Set<string>; removed: Set<string>; fingerprints: Map<string, string> }
const fingerprint = (message: Message): string => createHash('sha256').update(JSON.stringify([publicRoomMessage(message), message.reactions, message.error, message.attachments?.map(item => [item.id, item.kind, item.name, item.mime])])).digest('hex')
const sessionOf = (event: AgentEvent): string | undefined => event.type === 'session-updated' ? event.session.id : event.type === 'message-queue-updated' ? event.queue.sessionId : 'sessionId' in event ? event.sessionId : undefined
export class RoomRealtime {
  private readonly timelines = new Map<string, Timeline>()
  private readonly listeners = new Set<(sessionId: string) => void>()
  private timeline(id: string): Timeline {
    let timeline = this.timelines.get(id)
    if (!timeline) { timeline = { revision: 0, floor: 0, changed: new Map(), moved: new Map(), publicIds: new Set(), streaming: new Set(), removed: new Set(), fingerprints: new Map() }; this.timelines.set(id, timeline) }
    return timeline
  }
  revision(id: string): number { return this.timeline(id).revision }
  onChange(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  record(event: AgentEvent, role?: string): void {
    const id = sessionOf(event)
    if (!id) return
    // Private reasoning/trace/approval values never create remote text events.
    if (!['message-start', 'text-delta', 'message-end', 'session-updated', 'message-queue-updated', 'run-started', 'done', 'error', 'todos'].includes(event.type)) return
    const state = this.timeline(id), revision = ++state.revision
    const messageId = event.type === 'message-start' ? event.message.id : 'messageId' in event ? event.messageId : undefined
    if (event.type === 'message-start' && event.message.streaming) state.streaming.add(event.message.id)
    if (event.type === 'message-end') state.streaming.delete(event.messageId)
    if (messageId) {
      // Match state/events.ts: explicit public segments and assistant completion move to the end.
      const move = event.type === 'message-start' || (event.type === 'text-delta' ? !!event.segment : event.type === 'message-end' && role === 'assistant')
      state.changed.delete(messageId); state.changed.set(messageId, { revision, move })
      if (move) { state.moved.delete(messageId); state.moved.set(messageId, revision) }
      if (state.changed.size > 4096) { const first = state.changed.keys().next().value!; state.floor = state.changed.get(first)!.revision; state.changed.delete(first) }
    } else if (event.type === 'session-updated') {
      const current = new Set(event.session.messages.map(message => message.id))
      for (const message of event.session.messages) if (state.publicIds.has(message.id)) {
        const next = fingerprint(message), previous = state.fingerprints.get(message.id)
        if (previous && previous !== next) state.changed.set(message.id, { revision, move: false })
        state.fingerprints.set(message.id, next)
      }
      for (const id of state.publicIds) if (!current.has(id) && !state.streaming.has(id) && !state.removed.has(id)) { state.changed.set(id, { revision, move: false }); state.removed.add(id) }
      if (!event.session.messages.length && state.publicIds.size) state.floor = revision
    }
    for (const listener of this.listeners) { try { listener(id) } catch { /* observers cannot interrupt a run */ } }
  }
  snapshot(sessionId: string, stored: Message[], live: Message[]): Message[] {
    const state = this.timeline(sessionId), messages = new Map(stored.map(message => [message.id, message]))
    for (const message of live) {
      const saved = messages.get(message.id)
      if (!saved || saved.streaming) messages.set(message.id, message)
    }
    const ids = [...messages.keys()].filter(id => !state.moved.has(id))
    for (const id of state.moved.keys()) if (messages.has(id)) ids.push(id)
    return ids.map(id => messages.get(id)!)
  }
  markPublic(sessionId: string, ids: string[], source: Message[] = []): void { const state = this.timeline(sessionId), byId = new Map(source.map(message => [message.id, message])); for (const id of ids) { state.publicIds.add(id); state.removed.delete(id); const message = byId.get(id); if (message) state.fingerprints.set(id, fingerprint(message)) } }
  changes(sessionId: string, since: number) {
    const state = this.timeline(sessionId)
    return { revision: state.revision, reset: since < state.floor || since > state.revision, changes: [...state.changed].filter(([, change]) => change.revision > since).map(([id]) => ({ id, move: (state.moved.get(id) ?? 0) > since, wasPublic: state.publicIds.has(id) })) }
  }
  clear(): void { this.timelines.clear() }
}
export const roomRealtime = new RoomRealtime()
