/** Durable, source-scoped conversations with executors. No execution or user consent is inferred. */
import type { ProgressSnapshot } from './progressMonitor'
export interface CoordinationAction { kind: 'ask' | 'advise' | 'wait'; text: string; nextCheckMinutes?: number }
export interface CoordinationState { version: 1; owner: string; sequence: number; nextCheckAt: number; consideredReport?: string; awaitingReply?: string; operation?: string; delivery?: string; replyId?: string; lastAdviceText?: string; lastJudgmentAt?: number }
export interface CoordinationObservation { snapshot: ProgressSnapshot; report?: string; replies: string[]; deliveries?: Record<string,string> }
export interface CoordinationPorts {
  now(): number
  read(id: string): Promise<CoordinationState | null>
  write(id: string, state: CoordinationState): Promise<void>
  decide(s: ProgressSnapshot, context: { due: boolean; awaitingReply?: string; newReport?: string }): Promise<CoordinationAction | null>
  send(s: ProgressSnapshot, requestId: string, text: string, kind: 'ask' | 'advise'): Promise<string>
  error(id: string, e: unknown): void
}
export class TaskCoordinator {
  /** Routine executor messages never each trigger a costly judgment; the
   *  previously chosen check-in cadence and attention-worthy events do. */
  static readonly MIN_JUDGMENT_GAP_MS = 5 * 60_000
  private tails = new Map<string, Promise<void>>()
  constructor(private ports: CoordinationPorts) {}
  async observe(o: CoordinationObservation): Promise<void> {
    const id = o.snapshot.id
    const run = (this.tails.get(id) ?? Promise.resolve()).then(() => this.check(o)).catch(e => this.ports.error(id, e))
    this.tails.set(id, run)
    await run.finally(() => { if (this.tails.get(id) === run) this.tails.delete(id) })
  }
  private async check({snapshot:s,report,replies,deliveries}: CoordinationObservation): Promise<void> {
    const mayAsk = s.phase === 'running' && !s.terminal
    const eligible = !s.terminal && ['running','waiting_user','waiting_help','reconnecting'].includes(s.phase)
    const now = this.ports.now(), old = await this.ports.read(s.id)
    if (old && old.owner !== s.owner) throw Error('Coordination ownership changed')
    if (!old && (!eligible || !mayAsk && !report)) return
    const state: CoordinationState = old ? {...old} : {version:1,owner:s.owner,sequence:0,nextCheckAt:now+10*60_000}
    // Never replay a command whose transport acknowledgement was lost at exit.
    if (state.operation && deliveries?.[state.operation]) state.delivery = deliveries[state.operation]
    else if (state.operation && state.delivery === 'prepared') state.delivery = 'uncertain'
    const gotReply = Boolean(state.awaitingReply && replies.includes(`reply:${state.awaitingReply}`))
    if (gotReply) { state.replyId = `reply:${state.awaitingReply}`; delete state.awaitingReply }
    if (!eligible) { if (JSON.stringify(state)!==JSON.stringify(old)) await this.ports.write(s.id,state); return }
    const newReport = report && report !== state.consideredReport ? report : undefined
    const due = mayAsk && now >= state.nextCheckAt
    if (!due && !newReport) {
      if (JSON.stringify(state) !== JSON.stringify(old)) await this.ports.write(s.id,state)
      return
    }
    if (!due && newReport && mayAsk && !s.needsAttention && !gotReply && state.lastJudgmentAt !== undefined && now - state.lastJudgmentAt < TaskCoordinator.MIN_JUDGMENT_GAP_MS) {
      // Routine progress between check-ins: honor the cadence the Bot chose.
      // The report stays unconsidered so the next due check accounts for it.
      if (JSON.stringify(state) !== JSON.stringify(old)) await this.ports.write(s.id,state)
      return
    }
    const action = await this.ports.decide(s,{due,awaitingReply:state.awaitingReply,newReport})
    // Inference unavailable is retryable. Never invent a stock inquiry/advice.
    if (!action) { if (!old) await this.ports.write(s.id,state); return }
    state.lastJudgmentAt = now
    state.consideredReport = report
    const minutes = Number.isFinite(action.nextCheckMinutes) ? Math.min(30,Math.max(5,action.nextCheckMinutes!)) : 15
    state.nextCheckAt = now + minutes*60_000
    if (action.kind === 'wait') { await this.ports.write(s.id,state); return }
    if (action.kind === 'ask' && (!mayAsk || !due || state.awaitingReply)) {
      await this.ports.write(s.id,state); return
    }
    if (action.kind === 'advise' && action.text.trim() === state.lastAdviceText) { await this.ports.write(s.id,state); return }
    const priorAdvice=state.lastAdviceText
    if (action.kind === 'advise') state.lastAdviceText=action.text.trim()
    state.sequence++
    const requestId = `bot-coordinate:${s.id}:${state.sequence}`
    state.operation = requestId; state.delivery = 'prepared'
    state.awaitingReply = requestId
    await this.ports.write(s.id,state)
    const protocol = action.kind === 'ask'
      ? `\n\n[Bot coordination ${requestId}] Answer briefly with an ordinary assistant reply in this same execution conversation at its safe conversation boundary. The host persists and correlates this reply automatically; do not call a reporting/MCP tool or request permission solely to answer this inquiry. Describe observed progress, blockers and proposed adjustments with evidence. This is an internal inquiry, not a user message or permission to repeat/expand work.`
      : `\n\n[Bot coordination ${requestId}] This is the owning Bot's suggestion, not new user consent. Keep the existing goal, scope, approvals and safety rules. Do not treat it as authorization for external, destructive, paid or system-permission actions. Acknowledge with an ordinary reply in this same conversation, not a reporting/MCP call solely for acknowledgement; distinguish received from applied, and cite evidence when applied. Explain any unresolved decision to the owning Bot. Existing tools and approvals still govern any actual work.`
    try { state.delivery = await this.ports.send(s,requestId,action.text+protocol,action.kind) }
    catch { state.delivery = 'uncertain' }
    if(state.delivery==='not-permitted'||state.delivery==='deferred'){delete state.awaitingReply;state.lastAdviceText=priorAdvice}
    await this.ports.write(s.id,state)
  }
}
