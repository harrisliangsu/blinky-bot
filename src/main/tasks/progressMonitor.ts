/** Host-owned observation/outbox. Never executes, resumes or approves work. */
import { createHash } from 'node:crypto'
export type ProgressPhase = 'queued' | 'running' | 'waiting_user' | 'waiting_approval' | 'waiting_help' | 'reconnecting' | 'completed' | 'failed' | 'cancelled'
export interface ProgressSnapshot {
  id: string; owner: string; title: string; phase: ProgressPhase; progress: string; detail: string
  terminal: boolean; needsAttention: boolean; report?: string
}
export interface ProgressNotice { id: string; snapshot: string; text: string; kind?: 'quiet' }
export interface ProgressState {
  version: 1; owner: string; phase: ProgressPhase; progress: string
  lastProgressAt: number; lastNoticeAt: number; quietReported: boolean; sequence: number
  lastReport?: string
  pending?: ProgressNotice
}
export interface ProgressPorts {
  snapshots(): ProgressSnapshot[]
  read(id: string): Promise<ProgressState | null>
  write(id: string, state: ProgressState): Promise<void>
  /** Recheck ownership and snapshot immediately before an idempotent append. */
  post(snapshot: ProgressSnapshot, notice: ProgressNotice): Promise<boolean>
  now(): number
  error(id: string, error: unknown): void
}
export const PROGRESS_SCAN_MS = 60_000
export const PROGRESS_QUIET_MS = 5 * 60_000
export const PROGRESS_COALESCE_MS = 30_000
export const progressKey = (s: ProgressSnapshot): string => createHash('sha256').update(JSON.stringify([s.owner, s.phase, s.progress])).digest('hex')

/** One worker serializes events, timer recovery and disk retries. */
export class TaskProgressMonitor {
  private states = new Map<string, ProgressState | null>()
  private tail: Promise<void> = Promise.resolve()
  constructor(private ports: ProgressPorts) {}
  scan(): Promise<void> {
    const run = this.tail.then(async () => {
      for (const snapshot of this.ports.snapshots()) {
        try { await this.observe(snapshot) } catch (error) { this.ports.error(snapshot.id, error) }
      }
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  private async save(id: string, state: ProgressState): Promise<void> {
    await this.ports.write(id, state)
    this.states.set(id, state)
  }
  private async observe(s: ProgressSnapshot): Promise<void> {
    if (!this.states.has(s.id)) this.states.set(s.id, await this.ports.read(s.id))
    const old = this.states.get(s.id)
    if (old && old.owner !== s.owner) throw new Error('Progress ownership changed; no notice was forwarded.')
    const now = this.ports.now()
    let state: ProgressState = old ? { ...old } : { version: 1, owner: s.owner, phase: s.phase, progress: s.progress, lastProgressAt: now, lastNoticeAt: 0, quietReported: false, sequence: 0 }
    const phaseChanged = !old || state.phase !== s.phase
    const progressChanged = Boolean(old && state.progress !== s.progress)
    const key = progressKey(s)
    if (state.pending && state.pending.snapshot !== key) delete state.pending
    if (phaseChanged || progressChanged) {
      state.phase = s.phase; state.progress = s.progress; state.lastProgressAt = now; state.quietReported = false
    }
    if (s.report && s.report !== state.lastReport) {
      state.lastReport = s.report; state.lastProgressAt = now; state.quietReported = false
      // The explicit report is already an idempotent notice in the lead chat.
      if (state.pending?.kind === 'quiet') delete state.pending
    }
    const quiet = !s.terminal && ['running', 'queued', 'reconnecting'].includes(s.phase) && now - state.lastProgressAt >= PROGRESS_QUIET_MS && !state.quietReported
    // Do not replay historical finished work on first launch of the feature.
    const historical = !old && s.terminal && !s.needsAttention
    const milestone = progressChanged && now - state.lastNoticeAt >= PROGRESS_COALESCE_MS
    if (!state.pending && !historical && (phaseChanged || milestone || quiet)) {
      state.sequence++
      state.pending = { id: s.terminal && ['completed', 'failed'].includes(s.phase) ? `agent-result-notice-${s.id}` : `agent-monitor-${s.id}-${state.sequence}`, snapshot: key, ...(quiet ? { kind: 'quiet' as const } : {}), text: quiet
        ? `${s.title}：${s.phase === 'queued' ? '仍在排队。' : s.phase === 'reconnecting' ? '仍在等待连接恢复。' : '仍在运行，暂未收到新进展。'}`
        : `${s.title}：${s.detail || phaseText(s.phase)}` }
      if (quiet) state.quietReported = true
    }
    // Coalesce frequent todos; the next compensation scan publishes the latest.
    if (progressChanged && !milestone && !phaseChanged && !state.pending) state.progress = old!.progress
    if (JSON.stringify(state) !== JSON.stringify(old)) await this.save(s.id, state)
    if (!state.pending || !await this.ports.post(s, state.pending)) return
    const delivered = { ...state, lastNoticeAt: now }; delete delivered.pending
    await this.save(s.id, delivered)
  }
}
function phaseText(phase: ProgressPhase): string {
  return {
    queued: '排队中。', running: '正在执行。', waiting_user: '等你补充信息。',
    waiting_approval: '等你确认操作。', waiting_help: '需要你协助。',
    reconnecting: '正在恢复连接。', completed: '已返回结果，待核对。',
    failed: '执行失败，请核对已有结果。', cancelled: '已停止。'
  }[phase]
}
