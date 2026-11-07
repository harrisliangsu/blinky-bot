import type { AgentEvent } from '../../shared/types'

interface Notice { revision: number; sessionId?: string; kind: string }
/** Only identifiers and invalidation kinds are retained, never transcripts or credentials. */
export class WorkspaceEvents {
  private revision = 0
  private floor = 0
  private notices: Notice[] = []
  private readonly listeners = new Set<() => void>()
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  record(event: AgentEvent): void {
    const sessionId = event.type === 'session-updated' ? event.session.id : event.type === 'message-queue-updated' ? event.queue.sessionId : 'sessionId' in event ? event.sessionId : undefined
    if (['reasoning-delta', 'agent-trace', 'tool-call', 'tool-result'].includes(event.type)) return
    this.notices.push({ revision: ++this.revision, ...(sessionId ? { sessionId } : {}), kind: event.type === 'workspace-updated' ? 'workspace:' + event.area : event.type })
    if (this.notices.length > 2048) this.floor = this.notices.shift()!.revision
    for (const listener of this.listeners) { try { listener() } catch { /* cannot affect a run */ } }
  }
  since(revision: number) { return { revision: this.revision, reset: revision < this.floor || revision > this.revision, notices: this.notices.filter(notice => notice.revision > revision) } }
  clear(): void { this.notices = []; this.floor = ++this.revision; for (const listener of this.listeners) listener() }
}
export const workspaceEvents = new WorkspaceEvents()
