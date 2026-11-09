/** Host-owned observation/outbox. Judgment belongs to the owning Bot, never a timer. */
import { createHash } from 'node:crypto'
export type ProgressPhase = 'queued' | 'running' | 'waiting_user' | 'waiting_approval' | 'waiting_help' | 'reconnecting' | 'completed' | 'failed' | 'cancelled'
export interface ProgressEvidence { id: string; kind: 'message' | 'tool' | 'report'; text: string }
export interface ProgressSnapshot {
  id: string; owner: string; title: string; phase: ProgressPhase; progress: string; detail: string
  terminal: boolean; needsAttention: boolean; evidence?: ProgressEvidence[]
  /** Host-maintained structured progress carried with the snapshot. */
  structured?: import('../../shared/types').AgentTaskProgress
}
export interface ProgressNotice { id: string; snapshot: string; text: string }
export interface ProgressState {
  version: 2; owner: string; phase: ProgressPhase; progress: string; sequence: number
  assessed?: string; pending?: ProgressNotice
}
export type ProgressDecision = ({ kind: 'silent' } | { kind: 'milestone'; text: string; evidenceIds: string[] }) & { coordination?: import('./coordination').CoordinationAction }
export interface ProgressPorts {
  snapshots(): ProgressSnapshot[] | Promise<ProgressSnapshot[]>
  read(id: string): Promise<ProgressState | null>
  write(id: string, state: ProgressState): Promise<void>
  judge(snapshot: ProgressSnapshot): Promise<ProgressDecision | null>
  /** Recheck ownership and evidence immediately before an idempotent append. */
  post(snapshot: ProgressSnapshot, notice: ProgressNotice): Promise<boolean>
  error(id: string, error: unknown): void
}
/** Recovery polling only: elapsed time never makes a user-facing report. */
export const PROGRESS_SCAN_MS = 60_000
export const progressKey = (s: ProgressSnapshot): string => createHash('sha256').update(JSON.stringify([s.owner, s.phase, s.progress])).digest('hex')
export const requiresProgressNotice = (s: ProgressSnapshot): boolean => ['failed', 'cancelled', 'waiting_user', 'waiting_approval', 'waiting_help'].includes(s.phase)

export class TaskProgressMonitor {
  private states = new Map<string, ProgressState | null>()
  private tails = new Map<string, Promise<void>>()
  constructor(private ports: ProgressPorts) {}
  async scan(): Promise<void> {
    // A slow model for one Agent must not hold up another Agent's blocker.
    await Promise.all((await this.ports.snapshots()).map(snapshot => {
      const run = (this.tails.get(snapshot.id) ?? Promise.resolve()).then(() => this.observe(snapshot)).catch(error => this.ports.error(snapshot.id, error))
      this.tails.set(snapshot.id, run)
      return run.finally(() => { if (this.tails.get(snapshot.id) === run) this.tails.delete(snapshot.id) })
    }))
  }
  private async save(id: string, state: ProgressState): Promise<void> {
    await this.ports.write(id, state); this.states.set(id, state)
  }
  private async observe(s: ProgressSnapshot): Promise<void> {
    if (!this.states.has(s.id)) this.states.set(s.id, await this.ports.read(s.id))
    const old = this.states.get(s.id)
    if (old && old.owner !== s.owner) throw new Error('Progress ownership changed; no notice was forwarded.')
    const key = progressKey(s), state: ProgressState = old ? { ...old } : { version: 2, owner: s.owner, phase: s.phase, progress: s.progress, sequence: 0 }
    state.phase = s.phase; state.progress = s.progress
    if (state.pending && state.pending.snapshot !== key) delete state.pending
    const historical = !old && s.terminal && !s.needsAttention
    if (!state.pending && state.assessed !== key) {
      // Queued/running/todo changes are observations, never automatic milestones.
      const required = requiresProgressNotice(s)
      const decision = historical || !required && !s.evidence?.length ? { kind: 'silent' as const } : await this.ports.judge(s)
      if (decision) state.assessed = key
      const text = decision?.kind === 'milestone' ? decision.text : undefined
      // Unavailable inference remains unassessed for durable recovery. Never
      // bypass the Bot by forwarding a host template or the Agent's prose.
      if (text && !historical) {
        state.sequence++
        state.pending = { id: s.terminal && ['completed', 'failed'].includes(s.phase) ? `agent-result-notice-${s.id}` : `agent-monitor-${s.id}-${state.sequence}`, snapshot: key, text }
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(old)) await this.save(s.id, state)
    if (!state.pending || !await this.ports.post(s, state.pending)) return
    const delivered = { ...state }; delete delivered.pending
    await this.save(s.id, delivered)
  }
}
