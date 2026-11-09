import { supportsFullAccessExecution } from '../../shared/executionAccess'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentTask, AgentTaskStatus, Session } from '../../shared/types'
import type { AgentTaskProgress } from '../../shared/activity'
import { emitTelemetry } from '../telemetry'
import { JsonCollection } from './collection'
import { dataRoot, safeFileName, tasksDir } from './paths'
import { readJsonState, writeJsonNow } from './jsonStore'
import { conversationIsHome } from './bots'
import { archiveSession, getSession } from './sessions'
import { isThinkingDepth } from '../../shared/thinking'
import { parseSavedAcceptance } from '../tasks/acceptance'
import { parseSavedTaskPlan } from '../tasks/planning'
import { parseSavedTaskWorkspace } from '../tasks/workspaces'
import { parseTaskQuestions } from '../tasks/questionSchema'
import type { TaskPlan, TaskWorkspace } from '../../shared/taskPlan'

const collection = new JsonCollection<AgentTask>(tasksDir, normaliseTask)
const statuses: AgentTaskStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']
/** Waiting or working: the two statuses that describe live, uncompleted work. */
const active: AgentTaskStatus[] = ['queued', 'running']
const queuedByBot = new Map<string, number>()
const activeByBot = new Map<string, number>()
const runningBySession = new Map<string, number>()
let queuedCount = 0, activeCount = 0

function bump(index: Map<string, number>, key: string, delta: number): void {
  const count = (index.get(key) ?? 0) + delta
  if (count) index.set(key, count)
  else index.delete(key)
}
function indexTask(task: AgentTask, delta: number): void {
  if (task.status === 'queued') { queuedCount += delta; bump(queuedByBot, task.botId, delta) }
  if (active.includes(task.status)) { activeCount += delta; bump(activeByBot, task.botId, delta) }
  if (task.status === 'running') bump(runningBySession, task.sessionId, delta)
}
function putTask(task: AgentTask, persistedByRecovery = false): AgentTask {
  const previous = collection.get(task.id)
  if (previous) indexTask(previous, -1)
  const saved = persistedByRecovery ? collection.adopt(task) : collection.put(task)
  indexTask(saved, 1)
  return saved
}

type RecoveryEntry = { base: string; at: number; kind: 'execution' | 'delivery' }
type RecoveryJournal = { version: 1; entries: Record<string, RecoveryEntry> }
const recoveryHash = (task: AgentTask): string => createHash('sha256').update(JSON.stringify(normaliseTask(task))).digest('hex')
const interruptedMessage = 'BlinkyBot closed before this task finished; execution status is unknown. Inspect its work before retrying.'
/** Strictly identifies this store's execution-recovery outcome, not ordinary failures. */
export function taskExecutionWasInterrupted(task: AgentTask): boolean { return task.status === 'failed' && task.error === interruptedMessage && task.deliveryStatus === 'uncertain' }
function recoverTask(task: AgentTask, entry: RecoveryEntry): AgentTask {
  if (entry.kind === 'delivery') return { ...task, deliveryStatus: 'uncertain', updatedAt: entry.at }
  return { ...task, status: 'failed', error: interruptedMessage, updatedAt: entry.at,
    ...(task.sourceSessionId ? { result: interruptedMessage, deliveryStatus: 'uncertain' } : task.deliveryStatus === 'delivering' ? { deliveryStatus: 'uncertain' } : {}) }
}

/**
 * Finished tasks kept, newest first — the same bound `store/activity.ts` puts
 * on the inbox, for the same reason. Nothing ever trimmed this collection, so a
 * daily ten-bot broadcast left thousands of task documents behind, every one of
 * them read into memory at boot and walked by search.
 */
const MAX_FINISHED_TASKS = 200

function parseReview(raw: unknown, acceptance: AgentTask['acceptance'] | null): AgentTask['review'] | undefined {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return
  const review=raw as Record<string,unknown>
  if (!['complete_claimed','blocked'].includes(String(review.outcome)) || typeof review.summary!=='string' || !Array.isArray(review.evidence) || !Number.isFinite(review.recordedAt)) return
  let question: import('../../shared/types').AgentTaskQuestion | undefined
  if (review.question!==undefined) { try { question=parseTaskQuestions([review.question])[0] } catch { return } }
  return {outcome:review.outcome as 'complete_claimed'|'blocked',summary:review.summary.slice(0,10000),evidence:review.evidence.filter((item):item is string=>typeof item==='string').slice(0,20).map(item=>item.slice(0,2000)),recordedAt:Number(review.recordedAt),
    ...(question?{question}:{}),...(typeof review.respondedTo==='string'?{respondedTo:review.respondedTo}:{}),...(typeof review.contextKey==='string'?{contextKey:review.contextKey}:{}),
    ...(acceptance&&Array.isArray(review.verifiedFiles)?{verifiedFiles:parseSavedAcceptance({root:acceptance.root,files:review.verifiedFiles})?.files??[]}: {})}
}

export function normaliseTask(raw: unknown): AgentTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value['id'] !== 'string' || typeof value['botId'] !== 'string' || typeof value['sessionId'] !== 'string') return null
  const status = statuses.includes(value['status'] as AgentTaskStatus) ? value['status'] as AgentTaskStatus : 'failed'
  const progress = parseTaskProgress(value['progress'])
  const rawAgent = value['executionAgent']
  const agent = rawAgent && typeof rawAgent === 'object' && !Array.isArray(rawAgent) ? rawAgent as Record<string, unknown> : null
  const rawReview = value['review']
  const review = rawReview && typeof rawReview === 'object' && !Array.isArray(rawReview) ? rawReview as Record<string, unknown> : null
  const acceptance = parseSavedAcceptance(value['acceptance'])
  let plan: TaskPlan | undefined, workspace: TaskWorkspace | undefined, planInvalid = value['planInvalid'] === true
  try { plan = parseSavedTaskPlan(value['plan']); workspace = parseSavedTaskWorkspace(value['workspace']) } catch { planInvalid = true }
  const choice = value['sessionChoice'] as AgentTask['sessionChoice']
  return {
    id: value['id'], botId: value['botId'], sessionId: value['sessionId'], status,
    title: typeof value['title'] === 'string' ? value['title'].slice(0, 200) : 'Background task',
    prompt: typeof value['prompt'] === 'string' ? value['prompt'].slice(0, 100_000) : '',
    createdAt: Number(value['createdAt']) || Date.now(), updatedAt: Number(value['updatedAt']) || Date.now(),
    ...(plan ? { plan } : {}), ...(workspace ? { workspace } : {}), ...(planInvalid ? { planInvalid: true } : {}),
    ...(choice && ['new', 'continue'].includes(choice.mode) && typeof choice.reason === 'string' ? { sessionChoice: { mode: choice.mode, reason: choice.reason.slice(0, 2000), ...(typeof choice.previousTaskId === 'string' ? { previousTaskId: choice.previousTaskId } : {}) } } : {}),
    ...(typeof value['error'] === 'string' ? { error: value['error'].slice(0, 2000) } : {}),
    ...(typeof value['sourceSessionId'] === 'string' ? { sourceSessionId: value['sourceSessionId'] } : {}),
    ...(typeof value['requesterBotId'] === 'string' ? { requesterBotId: value['requesterBotId'] } : {}),
    ...(typeof value['continuedFromTaskId'] === 'string' ? { continuedFromTaskId: value['continuedFromTaskId'] } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...((value['acceptance'] !== undefined && !acceptance) || value['acceptanceInvalid'] === true ? { acceptanceInvalid: true } : {}),
    ...(agent && typeof agent['backendId'] === 'string' && typeof agent['modelId'] === 'string' ? { executionAgent: { backendId: agent['backendId'], modelId: agent['modelId'], ...(isThinkingDepth(agent['thinking']) ? { thinking: agent['thinking'] } : {}), ...(agent['accessMode'] === 'full-access' && supportsFullAccessExecution(agent['backendId']) ? { accessMode: 'full-access' as const } : {}) } } : {}),
    ...(typeof value['result'] === 'string' ? { result: value['result'].slice(0, 30000) } : {}),
    ...(parseReview(review,acceptance) ? { review: parseReview(review,acceptance)! } : {}),
    ...(Array.isArray(value['reviewHistory']) ? { reviewHistory: value['reviewHistory'].flatMap(item => { const parsed=parseReview(item,acceptance);return parsed?[parsed]:[] }) } : {}),
    ...(typeof value['decisionContext']==='string' ? {decisionContext:value['decisionContext']} : {}),
    ...(value['reviewFailure'] && typeof value['reviewFailure']==='object' && typeof (value['reviewFailure'] as Record<string,unknown>).contextKey==='string' && typeof (value['reviewFailure'] as Record<string,unknown>).message==='string' ? {reviewFailure:value['reviewFailure'] as AgentTask['reviewFailure']} : {}),
    ...(['pending', 'delivering', 'delivered', 'uncertain'].includes(value['deliveryStatus'] as string) ? { deliveryStatus: value['deliveryStatus'] as AgentTask['deliveryStatus'] } : {}),
    ...(progress ? { progress } : {})
  }
}

const PROGRESS_PHASES = ['queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_help', 'reconnecting', 'completed', 'failed', 'cancelled'] as const

function parseTaskProgress(raw: unknown): AgentTask['progress'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!PROGRESS_PHASES.includes(value['phase'] as typeof PROGRESS_PHASES[number]) || typeof value['detail'] !== 'string') return null
  const milestones = Array.isArray(value['milestones']) ? value['milestones'].flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    return typeof entry['text'] === 'string' && entry['text'].trim() && Number.isFinite(entry['at']) ? [{ text: entry['text'].slice(0, 200), at: Number(entry['at']) }] : []
  }).slice(-12) : []
  return {
    phase: value['phase'] as AgentTaskProgress['phase'],
    detail: value['detail'].slice(0, 400),
    ...(typeof value['blocker'] === 'string' && value['blocker'].trim() ? { blocker: value['blocker'].slice(0, 400) } : {}),
    milestones,
    updatedAt: Number(value['updatedAt']) || Date.now()
  }
}

let loadingTasks: Promise<void> | undefined
export function loadTasks(): Promise<void> {
  loadingTasks ??= readTasks().catch(error => { loadingTasks = undefined; throw error })
  return loadingTasks
}

async function readTasks(): Promise<void> {
  await collection.load()
  queuedCount = activeCount = 0
  queuedByBot.clear(); activeByBot.clear(); runningBySession.clear()
  for (const task of collection.all()) indexTask(task, 1)
  const path = join(dataRoot(), 'task-recovery.json')
  const journal = await readJsonState<RecoveryJournal>(path, { version: 1, entries: {} })
  if (journal.status === 'empty' || journal.status === 'corrupt' || journal.status === 'unreadable' || journal.value?.version !== 1 || !journal.value.entries || typeof journal.value.entries !== 'object' || Array.isArray(journal.value.entries) || Object.values(journal.value.entries).some(entry => !entry || typeof entry.base !== 'string' || !/^[a-f0-9]{64}$/.test(entry.base) || !Number.isFinite(entry.at) || !['execution','delivery'].includes(entry.kind))) throw new Error('Task recovery journal is unreadable; old work was not resumed.')
  const entries: Record<string, RecoveryEntry> = Object.create(null), recovered: AgentTask[] = []
  // An active task cannot survive the main process that owned its model stream.
  // Make that explicit instead of leaving a permanent "running" spinner after
  // a crash or forced quit.
  for (const task of collection.all()) {
    const base = recoveryHash(task), prior = journal.value.entries[task.id]
    const kind: RecoveryEntry['kind'] | undefined = active.includes(task.status) ? 'execution' : task.deliveryStatus === 'delivering' ? 'delivery' : undefined
    if (!kind) continue
    const entry: RecoveryEntry = prior?.base === base && prior.kind === kind ? prior : { base, kind, at: Math.max(Date.now(), Number.isFinite(task.updatedAt) ? task.updatedAt + 1 : 0) }
    entries[task.id] = entry
    recovered.push(recoverTask(task, entry))
  }
  // One atomic journal commit replaces tens of thousands of fsync/rename
  // operations. Original task files are retained; hashes stop an old correction
  // overriding a task file subsequently updated by an ordinary durable write.
  if (JSON.stringify(entries) !== JSON.stringify(journal.value.entries)) await writeJsonNow(path, { version: 1, entries } satisfies RecoveryJournal)
  for (const task of recovered) putTask(task, true)
}
export const listTasks = (): AgentTask[] => collection.all().sort((a, b) => b.updatedAt - a.updatedAt)
export const tasksLoadWasIncomplete = (): boolean => collection.loadWasIncomplete
export const getTask = (id: string): AgentTask | null => collection.get(id)

/** Queued + running liveness, for every bot or just one; not queue capacity. */
export function countActiveTasks(botId?: string): number {
  return botId === undefined ? activeCount : activeByBot.get(botId) ?? 0
}

/** Waiting tasks only. Running work occupies the execution pool, not this bound. */
export function countQueuedTasks(botId?: string): number {
  return botId === undefined ? queuedCount : queuedByBot.get(botId) ?? 0
}

/**
 * True while a background task is running in this session.
 *
 * The task pipeline posts its own inbox item when a run settles, so
 * `ipc/broadcast` uses this to skip the duplicate it used to post for the same
 * failure. A finished task deliberately does not count: once the pipeline has
 * settled, nothing else would report a later failure in that chat. A queued
 * task does not count either — the home chat is the user's chat, and a task
 * waiting its turn must not swallow that chat's own notifications.
 */
export const hasActiveTask = (sessionId: string): boolean =>
  (runningBySession.get(sessionId) ?? 0) > 0

/**
 * Forget the oldest finished tasks and archive the session each one owned.
 *
 * Archived rather than deleted: the session *is* the run's output — the reply
 * the user asked for — and the task record is only the metadata around it.
 * Archiving keeps it readable and reachable, while taking it out of the sidebar
 * and out of search. It also means an in-flight run can never lose its session:
 * only finished tasks are considered here, and even then nothing is removed.
 *
 * Returns the sessions that changed so the caller can announce them.
 */
export function trimTasks(): Session[] {
  const finished = collection
    .all()
    // Independent Agent records are the index for their read-only execution
    // transcripts and continuation chain. Removing one would make the user's
    // history unreachable and could break a later continuation.
    .filter((task) => !task.sourceSessionId && !active.includes(task.status) && (!task.deliveryStatus || task.deliveryStatus === 'delivered'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const archived: Session[] = []
  for (const task of finished.slice(MAX_FINISHED_TASKS)) {
    indexTask(task, -1)
    collection.delete(task.id)
    const session = getSession(task.sessionId)
    if (!session || session.archived) continue
    /*
     * A task's chat is an ordinary session: the user can open it and carry on
     * talking, which moves `session.updatedAt` while `task.updatedAt` stays
     * frozen at the moment the task settled. Ranking by the task alone then
     * archived a conversation that was live — it vanished from the sidebar and
     * from search mid-sentence. The session's own clock is what decides.
     */
    if (session.updatedAt > task.updatedAt) continue
    // Background work posts into the bot's home chat. Archiving that file
    // would hide the bot, not a disposable task log.
    if (conversationIsHome(session.id)) continue
    const next = archiveSession(task.sessionId)
    if (next) archived.push(next)
  }
  return archived
}

type TaskExtra = Pick<AgentTask, 'sourceSessionId' | 'requesterBotId' | 'executionAgent' | 'continuedFromTaskId' | 'acceptance' | 'acceptanceInvalid' | 'plan' | 'planInvalid' | 'workspace' | 'sessionChoice' | 'decisionContext'>
function newTaskRecord(botId: string, sessionId: string, prompt: string, title: string, extra?: TaskExtra): AgentTask {
  const now = Date.now()
  return { id: randomUUID(), botId, sessionId, prompt: prompt.slice(0, 100_000), title: title.slice(0, 200) || 'Background task', status: 'queued', createdAt: now, updatedAt: now, ...extra }
}

export function createTaskRecord(botId: string, sessionId: string, prompt: string, title: string, extra?: TaskExtra): AgentTask {
  return putTask(newTaskRecord(botId, sessionId, prompt, title, extra))
}

export async function createTaskRecordDurable(botId: string, sessionId: string, prompt: string, title: string, extra?: TaskExtra): Promise<AgentTask> {
  const task = newTaskRecord(botId, sessionId, prompt, title, extra)
  await writeJsonNow(join(tasksDir(), `${safeFileName(task.id)}.json`), task)
  return putTask(task)
}

/** Call under the task's orchestration lock so cancellation/updates stay ordered. */
export async function saveTaskRuntimeDurable(id: string, patch: Pick<AgentTask, 'plan' | 'workspace' | 'sessionChoice' | 'reviewFailure'>): Promise<AgentTask> {
  const current = collection.get(id)
  if (!current) throw new Error('The task no longer exists.')
  const next = { ...current, ...patch, updatedAt: Date.now() }
  await writeJsonNow(join(tasksDir(), safeFileName(id) + '.json'), next)
  return putTask(next)
}

export function setTaskStatus(id: string, status: AgentTaskStatus, error?: string): AgentTask | null {
  const task = collection.get(id)
  if (!task) return null
  if (['completed', 'failed', 'cancelled'].includes(status) && task.status !== status) emitTelemetry({ kind: 'task.terminal', taskId: id, botId: task.botId, outcome: status, durationMs: Date.now() - task.createdAt })
  const next: AgentTask = { ...task, status, updatedAt: Date.now() }
  if (error) next.error = error.slice(0, 2000)
  else delete next.error
  return putTask(next)
}

/** Atomically persist the terminal result and its yet-to-be-consumed inbox entry. */
export function completeAgentTask(id: string, result: string, failed = false): AgentTask | null {
  const task = collection.get(id)
  if (!task) return null
  return putTask({ ...task, status: failed ? 'failed' : 'completed', result: result.slice(0, 30000), deliveryStatus: 'pending', updatedAt: Date.now(), ...(failed ? { error: result.slice(0, 2000) } : {}) })
}

/** Preserve cancellation as its own terminal state and report it to the lead. */
export function cancelAgentTask(id: string): AgentTask | null {
  const task = collection.get(id)
  if (!task) return null
  const result = 'The background task was stopped. Some work may already have occurred; inspect its output and changes before retrying.'
  return putTask({ ...task, status: 'cancelled', result, deliveryStatus: 'uncertain', updatedAt: Date.now() })
}

export function updateTaskDelivery(id: string, deliveryStatus: NonNullable<AgentTask['deliveryStatus']>): AgentTask | null {
  const task = collection.get(id)
  return task ? putTask({ ...task, deliveryStatus, updatedAt: Date.now() }) : null
}

/** Atomically persist the host-maintained structured progress; no-ops when the
 *  exact value is already stored so periodic scans do not churn the disk. */
export async function recordTaskProgress(id: string, progress: AgentTask['progress']): Promise<AgentTask | null> {
  if (!progress) return null
  const current = collection.get(id)
  if (!current) return null
  if (current.progress && JSON.stringify({ ...current.progress, updatedAt: 0 }) === JSON.stringify({ ...progress, updatedAt: 0 })) return current
  const next: AgentTask = { ...current, progress, updatedAt: Date.now() }
  await writeJsonNow(join(tasksDir(), `${safeFileName(id)}.json`), next)
  return putTask(next)
}

export async function storeTaskReviewDurable(id: string, review: NonNullable<AgentTask['review']>): Promise<AgentTask | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const task = collection.get(id)
    if (!task) return null
    const next = { ...task, review, reviewFailure:undefined, ...(task.review && JSON.stringify(task.review)!==JSON.stringify(review) ? {reviewHistory:[...(task.reviewHistory??[]),task.review]} : {}), updatedAt: Date.now() }
    await writeJsonNow(join(tasksDir(), `${safeFileName(id)}.json`), next)
    if (collection.get(id) === task) return putTask(next)
  }
  throw new Error('The task changed too quickly to save its assessment safely.')
}
