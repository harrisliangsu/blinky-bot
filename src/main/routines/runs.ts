/** Local occurrence ledger. A claimed occurrence is never automatically replayed. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { dataRoot, ensureDir } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'
import type { AgentTask } from '../../shared/types'
import type { RoutineRun } from '../../shared/routines'
export type { RoutineRun } from '../../shared/routines'

function directory(): string { return ensureDir(join(dataRoot(), 'routine-runs')) }
function runId(routineId: string, at: number, signalId?: string): string {
  return createHash('sha256').update(JSON.stringify(signalId ? [routineId, 'webhook', signalId] : [routineId, at])).digest('hex')
}
function file(id: string): string { return join(directory(), `${id}.json`) }

function isRun(value: unknown): value is RoutineRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Partial<RoutineRun>
  return typeof run.routineId === 'string' && !!run.routineId &&
    typeof run.scheduledAt === 'number' && Number.isFinite(run.scheduledAt) &&
    (run.webhook === undefined || (typeof run.webhook === 'object' && run.webhook !== null &&
      /^webhook-[a-f0-9]{64}$/.test(run.webhook.signalId) && typeof run.webhook.botId === 'string' && !!run.webhook.botId &&
      typeof run.webhook.sessionId === 'string' && !!run.webhook.sessionId)) &&
    run.id === runId(run.routineId, run.scheduledAt, run.webhook?.signalId) &&
    ['claimed', 'running', 'awaiting_review', 'finished', 'failed', 'missed', 'unknown', 'skipped'].includes(run.status ?? '') &&
    [run.startedAt, run.endedAt, run.missedFrom, run.resultObservedAt].every((at) => at === undefined || (typeof at === 'number' && Number.isFinite(at))) &&
    (run.missedCount === undefined || (Number.isSafeInteger(run.missedCount) && run.missedCount > 0)) &&
    (run.taskIds === undefined || (Array.isArray(run.taskIds) && run.taskIds.length > 0 && run.taskIds.every((id) => typeof id === 'string' && !!id))) &&
    (run.status !== 'awaiting_review' || Boolean(run.taskIds?.length)) &&
    (run.result === undefined || typeof run.result === 'string') &&
    (run.resultFingerprint === undefined || /^[a-f0-9]{64}$/.test(run.resultFingerprint)) &&
    (run.notificationState === undefined || ['ready','pending','recorded','quiet','baseline','unchanged','uncertain'].includes(run.notificationState))
}

/** O_EXCL is the admission boundary even when two processes notice the same minute. */
export async function claimRoutineRun(routineId: string, scheduledAt: number, now = Date.now(), missed?: { firstAt: number; count: number }): Promise<RoutineRun | null> {
  if (!routineId || !Number.isFinite(scheduledAt) || !Number.isFinite(now) ||
    (missed && (!Number.isFinite(missed.firstAt) || !Number.isSafeInteger(missed.count) || missed.count < 1))) throw new TypeError('Invalid routine occurrence.')
  const run: RoutineRun = {
    id: runId(routineId, scheduledAt), routineId, scheduledAt,
    ...(missed ? { status: 'missed', missedFrom: missed.firstAt, missedCount: missed.count, endedAt: now } : { status: 'claimed' })
  }
  return claim(run)
}

/** Received time can collide; the authenticated signal ID is the occurrence identity. */
export async function claimWebhookRoutineRun(routineId: string, signalId: string, botId: string, sessionId: string, receivedAt: number): Promise<RoutineRun | null> {
  if (!routineId || !/^webhook-[a-f0-9]{64}$/.test(signalId) || !botId || !sessionId || !Number.isFinite(receivedAt)) throw new TypeError('Invalid webhook occurrence.')
  return claim({ id: runId(routineId, receivedAt, signalId), routineId, scheduledAt: receivedAt, status: 'claimed', webhook: { signalId, botId, sessionId } })
}

async function claim(run: RoutineRun): Promise<RoutineRun | null> {
  let handle: fs.FileHandle
  try { handle = await fs.open(file(run.id), 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error }
  // A failed or partial claim stays in place. Erasing it could authorize a
  // duplicate after a crash. Reads report it as unreadable instead.
  try { await handle.writeFile(JSON.stringify(run)); await handle.sync() }
  finally { await handle.close() }
  const parent = await fs.open(directory(), 'r')
  try { await parent.sync() } finally { await parent.close() }
  return run
}

/** A corrupt claim remains in place and cannot authorize a second execution. */
export async function getRoutineRun(id: string): Promise<RoutineRun | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid routine run ID.')
  let text: string
  try { text = await fs.readFile(file(id), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const run: unknown = JSON.parse(text)
  if (!isRun(run) || run.id !== id) throw new Error('例程运行记录无效，未重试。')
  return run
}

export async function finishRoutineRun(run: RoutineRun, status: 'finished' | 'failed' | 'unknown' | 'skipped', detail?: string, endedAt = Date.now()): Promise<RoutineRun> {
  if (status === 'finished' && run.startedAt === undefined) throw new Error('尚未开始的例程不能标记完成。')
  const next: RoutineRun = { ...run, status, endedAt, ...(detail ? { detail: detail.slice(0, 2000) } : {}), notificationState: 'ready' }
  if (status === 'skipped') delete next.startedAt
  await writeJsonNow(file(run.id), next)
  return next
}

export async function startRoutineRun(run: RoutineRun, now = Date.now()): Promise<RoutineRun> {
  const next: RoutineRun = { ...run, status: 'running', startedAt: now }
  await writeJsonNow(file(run.id), next)
  return next
}

export async function saveRoutineRun(run: RoutineRun): Promise<RoutineRun> {
  if (!isRun(run)) throw new Error('例程记录无效，未覆盖。')
  await writeJsonNow(file(run.id), run)
  return run
}

/** At most one process may request a notification for an occurrence. */
export async function claimRoutineNotification(run: RoutineRun): Promise<boolean> {
  if (!isRun(run)) throw new Error('例程通知记录无效。')
  let handle: fs.FileHandle
  try { handle = await fs.open(join(directory(), `${run.id}.notice`), 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
  try { await handle.writeFile(run.id); await handle.sync() } finally { await handle.close() }
  const parent = await fs.open(directory(), 'r')
  try { await parent.sync() } finally { await parent.close() }
  return true
}

/** The Bot returning after dispatch is a wait boundary, not the routine's completion. */
export async function awaitRoutineReview(run: RoutineRun, taskIds: string[]): Promise<RoutineRun> {
  if (!taskIds.length) throw new TypeError('A pending review needs its delegated tasks.')
  const next: RoutineRun = { ...run, status: 'awaiting_review', taskIds: [...new Set(taskIds)] }
  await writeJsonNow(file(run.id), next)
  return next
}

/** Follow the same durable continuation chain used by the main result inbox. */
export function routineReviewOutcome(run: RoutineRun, tasks: AgentTask[]): { status: 'finished' | 'unknown'; detail: string; result?: string } | null {
  if (!run.taskIds?.length) return { status: 'unknown', detail: '例程缺少后台任务记录，无法确认结果。' }
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const results: string[] = []
  for (const id of run.taskIds) {
    let task = byId.get(id)
    if (task && run.webhook && (task.sourceSessionId !== run.webhook.sessionId || (task.requesterBotId ?? task.botId) !== run.webhook.botId)) return { status: 'unknown', detail: 'Webhook 后台任务不属于原 Bot／对话，未确认完成。' }
    const seen = new Set<string>()
    while (task) {
      if (seen.has(task.id)) return { status: 'unknown', detail: '后台任务续接记录存在循环，无法确认结果。' }
      seen.add(task.id)
      const next = tasks.filter((candidate) => candidate.continuedFromTaskId === task!.id)
      if (!next.length) break
      const child = next[0]!
      if (next.length !== 1 || child.sourceSessionId !== task.sourceSessionId || child.sessionId !== task.sessionId || child.botId !== task.botId || (child.requesterBotId ?? child.botId) !== (task.requesterBotId ?? task.botId)) return { status: 'unknown', detail: '后台任务续接记录不一致，无法确认结果。' }
      task = child
    }
    if (!task || task.deliveryStatus === 'uncertain' || task.status === 'cancelled') return { status: 'unknown', detail: '后台任务已中断或送达状态不明；请核对实际工作，未自动重试。' }
    if (task.deliveryStatus !== 'delivered') return null
    if (task.review?.outcome !== 'complete_claimed') return { status: 'unknown', detail: '主聊天尚未判断任务完成，请查看其复核结论和阻塞原因。' }
    results.push(task.review.summary)
  }
  return { status: 'finished', detail: '后台任务结果已送达，主聊天已记录完成判断；该判断不等于对全部业务效果的独立证明。', result: results.join('\n\n').slice(0, 4000) }
}

export async function listRoutineRuns(routineId?: string): Promise<RoutineRun[]> {
  const runs: RoutineRun[] = []
  // Never quarantine a malformed claim: moving it out of the way would let
  // O_EXCL admit that same occurrence again after an interrupted initial write.
  for (const name of await fs.readdir(directory())) {
    if (!name.endsWith('.json')) continue
    const value: unknown = JSON.parse(await fs.readFile(join(directory(), name), 'utf8'))
    if (!isRun(value) || name !== `${value.id}.json`) throw new Error('例程运行记录无效；未重试状态不明的计划。')
    if (routineId === undefined || value.routineId === routineId) runs.push(value)
  }
  return runs.sort((a, b) => b.scheduledAt - a.scheduledAt)
}

/** Startup only, before admitting new work. Never turns a crash into a retry. */
export async function recoverRoutineRuns(): Promise<RoutineRun[]> {
  const recovered: RoutineRun[] = []
  for (const run of await listRoutineRuns()) recovered.push(run.status === 'running'
    ? await finishRoutineRun(run, 'unknown', 'BlinkyBot 在本次运行结束前退出；请核对实际工作，未自动重试。')
    : run.status === 'claimed' ? await finishRoutineRun(run, 'skipped', '启动前应用退出，未自动执行。')
    : run.notificationState === 'pending' ? await saveRoutineRun({ ...run, notificationState: 'uncertain' }) : run)
  return recovered
}

let startupRecovery: Promise<RoutineRun[]> | undefined
/** Shared by queue admission and the timer: never recover over a new live run. */
export function initializeRoutineRuns(): Promise<RoutineRun[]> {
  startupRecovery ??= recoverRoutineRuns().catch(error => { startupRecovery = undefined; throw error })
  return startupRecovery
}
