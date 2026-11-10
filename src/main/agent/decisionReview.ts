/** A review is a scoped workflow in the existing tool loop, never an approval. */
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { Skill } from '../../shared/skills'
import type { ToolCall, ToolResult } from '../../shared/types'
import type { ToolContext } from '../tools/types'
import { skillsFor } from '../skills/index'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { decisionReviewGeneration } from './decisionReviewLifecycle'

const WINDOW_MS = 120_000
type Status = 'pending' | 'reviewed' | 'uncertain' | 'unreviewed'
interface Receipt { id: string; name: string; ok: boolean; contractRead?: boolean; invocation?: boolean; digest: string }
interface Review {
  id: string; key: string; botId: string; sessionId: string; node: string; createdAt: number
  status: Status; reason?: string; skillId?: string; contract?: string; contractHash?: string
  receipts: Receipt[]
}
interface Ledger { version: 1; botId: string; sessionId: string; reviews: Review[] }
const locks = new Map<string, Promise<unknown>>()
const active = new Map<string, Review>()
let generation = decisionReviewGeneration()
function checkGeneration(): void {
  if (generation !== decisionReviewGeneration()) { generation = decisionReviewGeneration(); active.clear() }
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const scope = (ctx: ToolContext): string => digest(`${ctx.dataDir}\0${ctx.botId}\0${ctx.sessionId}`)
const file = (ctx: ToolContext): string => join(ctx.dataDir!, 'decision-reviews', `${scope(ctx)}.json`)
const enabled = (ctx: ToolContext): boolean => (ctx.getSettings?.() ?? ctx.settings)?.decisionSkillReview === true
async function serial<T>(ctx: ToolContext, run: () => Promise<T>): Promise<T> {
  const key = scope(ctx), pending = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
  locks.set(key, pending)
  try { return await pending } finally { if (locks.get(key) === pending) locks.delete(key) }
}
async function ledger(ctx: ToolContext): Promise<Ledger> {
  const read = await readJsonState<Ledger>(file(ctx), { version: 1, botId: ctx.botId, sessionId: ctx.sessionId, reviews: [] })
  if (read.status === 'unreadable' || read.status === 'corrupt') throw Error('Review history is unavailable; continue without review.')
  const value = read.value
  if (value.version !== 1 || value.botId !== ctx.botId || value.sessionId !== ctx.sessionId || !Array.isArray(value.reviews)) throw Error('Review ownership is invalid.')
  for (const item of value.reviews) if (item.status === 'pending' && (active.get(scope(ctx))?.id !== item.id || Date.now() >= item.createdAt + WINDOW_MS)) {
    item.status = 'unreviewed'; item.reason = Date.now() >= item.createdAt + WINDOW_MS ? 'timeout' : 'interrupted'
    if (active.get(scope(ctx))?.id === item.id) active.delete(scope(ctx))
  }
  return value
}
function output(item: Review): Record<string, unknown> {
  return { review_id: item.id, status: item.status, reason: item.reason, skill_id: item.skillId,
    receipts: item.receipts.map(({ id, name, ok }) => ({ id, name, ok })),
    note: 'Receipts establish tool execution, not correctness or user approval. Continue independent work; do not repeat unchanged inputs.' }
}
const text = (args: Record<string, unknown>, key: string, max = 12000): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`A concrete ${key} is required (max ${max} characters).`)
  return value.trim()
}
/** Installed skills are a menu. The intelligent layer selects by the actual task and contract. */
export async function decisionReview(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  checkGeneration()
  if (!enabled(ctx)) { active.delete(scope(ctx)); return { status: 'disabled', note: 'Automatic skill review is off. Do not proactively invoke a review skill.' } }
  if (!ctx.dataDir || ctx.computerTarget?.kind === 'vm' || !ctx.backendId) return { status: 'unreviewed', reason: 'runtime-unavailable', note: 'This runtime cannot verify its installed decision skills. Continue independent work.' }
  return serial(ctx, async () => {
    const log = await ledger(ctx)
    if (args.action === 'begin') {
      const node = text(args, 'node', 30)
      if (!['development_plan', 'major_conclusion', 'substantial_adjustment'].includes(node)) throw Error('Choose a substantive development decision, not a routine detail.')
      const subject = text(args, 'subject'), evidence = text(args, 'evidence', 24000)
      const installed = await skillsFor(ctx.backendId!, { cwd: ctx.cwd, refresh: true })
      if (!enabled(ctx) || ctx.signal.aborted) return { status: 'disabled' }
      const catalog = installed.map(s => [s.id, s.path, s.updatedAt])
      const key = digest(JSON.stringify([node, subject.replace(/\s+/g, ' '), evidence.replace(/\s+/g, ' '), catalog]))
      const existing = log.reviews.find(item => item.key === key)
      if (existing) { await writeJsonNow(file(ctx), log); return { ...output(existing), duplicate: true } }
      const previous = active.get(scope(ctx))
      if (previous && Date.now() - previous.createdAt < WINDOW_MS) return { ...output(previous), busy: true }
      const review: Review = { id: randomUUID(), key, botId: ctx.botId, sessionId: ctx.sessionId, node, createdAt: Date.now(), status: installed.length ? 'pending' : 'unreviewed', ...(installed.length ? {} : { reason: 'skill-missing' }), receipts: [] }
      log.reviews.push(review)
      // No raw prompts, evidence, commands, outputs, or credentials in this ledger.
      await writeJsonNow(file(ctx), log)
      if (review.status === 'pending') active.set(scope(ctx), review)
      return { ...output(review), skills: installed.map((skill: Skill) => ({ id: skill.id, name: skill.name, description: skill.description, contract: join(skill.path, 'SKILL.md') })),
        next: 'Select an appropriate decision skill by its description (select + skill_id), or finish unreviewed if none applies. Read its contract with read_file, then use existing permitted tools exactly as required, passing this specific subject and evidence. Finish with a brief judgment based on actual results. Use ordinary tool timeouts within the two-minute review window. Do not acquire credentials, authorize new effects, or substitute a different service.' }
    }
    const id = text(args, 'review_id', 100), item = log.reviews.find(row => row.id === id)
    if (!item) throw Error('Review does not belong to this Bot and conversation.')
    if (item.status !== 'pending') return output(item)
    if (Date.now() - item.createdAt >= WINDOW_MS) { item.status = 'unreviewed'; item.reason = 'timeout' }
    else if (args.action === 'select') {
      const skillId = text(args, 'skill_id', 200)
      if (item.skillId && item.skillId !== skillId) throw Error('Do not switch services or retry an unchanged review.')
      const installed = await skillsFor(ctx.backendId!, { cwd: ctx.cwd, refresh: true }), skill = installed.find(row => row.id === skillId)
      if (!skill) { item.status = 'unreviewed'; item.reason = 'skill-unavailable' }
      else {
        const contract = join(skill.path, 'SKILL.md'), info = await stat(contract)
        if (!info.isFile() || info.size > 512 * 1024) throw Error('Skill contract is unavailable.')
        item.skillId = skill.id; item.contract = resolve(contract); item.contractHash = digest(await readFile(contract, 'utf8'))
      }
    } else if (args.action === 'finish') {
      const status = args.status
      if (!['reviewed', 'uncertain', 'unreviewed'].includes(String(status))) throw Error('Finish as reviewed, uncertain or unreviewed.')
      text(args, 'summary', 2000) // Return to the normal transcript; never persist a second plaintext copy.
      const reads = item.receipts.some(row => row.contractRead && row.ok)
      const invoked = item.receipts.some(row => row.invocation && row.ok)
      const failed = item.receipts.some(row => row.invocation && !row.ok)
      item.status = status === 'reviewed' && reads && invoked && !failed ? 'reviewed' : status === 'uncertain' && reads && invoked ? 'uncertain' : 'unreviewed'
      item.reason = item.status === 'reviewed' ? 'tool-receipts-checked' : failed ? 'execution-failed' : !reads || !invoked ? 'no-verifiable-execution' : 'inconclusive'
    } else throw Error('Use begin, select or finish.')
    await writeJsonNow(file(ctx), log)
    if (item.status === 'pending') active.set(scope(ctx), item); else active.delete(scope(ctx))
    return { ...output(item), ...(item.status === 'pending' ? { contract: item.contract, expires_at: item.createdAt + WINDOW_MS } : {}) }
  })
}

/** Both the in-app and native MCP loop enter here after normal authorization. */
export async function reviewToolExecution(call: ToolCall, ctx: ToolContext, run: (context: ToolContext) => Promise<ToolResult>): Promise<ToolResult> {
  checkGeneration()
  const item = active.get(scope(ctx))
  if (!enabled(ctx)) { active.delete(scope(ctx)); return run(ctx) }
  if (call.name === 'decision_review' || !item || item.status !== 'pending' || !item.skillId) return run(ctx)
  const remaining = item.createdAt + WINDOW_MS - Date.now()
  if (remaining <= 0) {
    try { await serial(ctx, async () => { const log = await ledger(ctx); await writeJsonNow(file(ctx), log) }) }
    finally { active.delete(scope(ctx)) }
    return { callId: call.id, name: call.name, ok: false, output: 'Decision review timed out and is unreviewed. Continue independent work without retrying this unchanged review.' }
  }
  const result = await run({ ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(remaining)]) })
  const contractRead = call.args?.start_line === undefined && call.args?.end_line === undefined && call.name === 'read_file' && typeof call.args?.path === 'string' && resolve(ctx.cwd, call.args.path) === item.contract && !(result.detail as { truncated?: boolean } | undefined)?.truncated
  const invocation = ['shell', 'fetch', 'web_search'].includes(call.name) // Coordination or locally writing a result is not a review invocation.
  if (contractRead || invocation) try { await serial(ctx, async () => {
    checkGeneration()
    const log = await ledger(ctx), fresh = log.reviews.find(row => row.id === item.id)
    if (!fresh || fresh.status !== 'pending') return
    const validContract = fresh.contract && fresh.contractHash === digest(await readFile(fresh.contract, 'utf8').catch(() => ''))
    const receipt: Receipt = { id: call.id, name: call.name, ok: result.ok && !!validContract && Date.now() < fresh.createdAt + WINDOW_MS,
      contractRead, invocation: invocation && fresh.receipts.some(row => row.contractRead && row.ok), digest: digest(JSON.stringify([call.name, call.args, result.ok, result.output])) }
    fresh.receipts.push(receipt)
    if (!receipt.ok) { fresh.status = 'unreviewed'; fresh.reason = Date.now() >= fresh.createdAt + WINDOW_MS ? 'timeout' : 'execution-failed' }
    await writeJsonNow(file(ctx), log)
    if (fresh.status === 'pending') active.set(scope(ctx), fresh); else active.delete(scope(ctx))
  }) } catch {
    active.delete(scope(ctx))
    // The actual tool already ran: never turn a bookkeeping failure into a retry.
    return { ...result, output: result.output + '\nDecision review receipts could not be saved; treat this review as unreviewed. Do not repeat the action.' }
  }
  return result
}

export { interruptDecisionReviews } from './decisionReviewLifecycle'
