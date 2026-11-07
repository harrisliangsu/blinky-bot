import { agentProgressName, agentProgressReport } from './tasks/progressText'
import { recordTaskMilestone } from './tasks/progressObservations'
/** Background-task orchestration shared by the renderer and delegate_task. */

import type { AgentTask } from '../shared/types'
import type { TaskPlanInput } from '../shared/taskPlan'
import { createHash } from 'node:crypto'
import { summariseTask, type AgentTaskCommand, type AgentTaskMessageReceipt } from '../shared/activity'
import { isRunning } from './agent/cancel'
import { loopFn } from './ipc/agentRuntime'
import { postActivity } from './ipc/broadcast'
import { getBot } from './store/bots'
import { ensureBotHome } from './store/botHome'
import { createSession, getSession, saveSession, setSessionCwd } from './store/sessions'
import { cancelAgentTask, completeAgentTask, countQueuedTasks, createTaskRecordDurable, getTask, listTasks, saveTaskRuntimeDurable, setTaskStatus, storeTaskReviewDurable, taskExecutionWasInterrupted, trimTasks, updateTaskDelivery } from './store/tasks'
import { flushAll } from './store/jsonStore'
import { clearExecutionAgent, clearTeammateRun, setExecutionAgent, setTeammateRun } from './agent/executionAgent'
import { addNotice, addUserMessage } from './agent/messages'
import { sessions } from './agent/sessionGateway'
import { broadcast, onAgentEvent } from './agent/events'
import { hasPendingQueueWrite, isStarting, isStartCancelled, reserveStart, releaseStart } from './agent/startReservation'
import { isQueueDraining, isQueueSuspended, queueSuspensionGeneration } from './agent/messageQueueRuntime'
import { getMessageQueue } from './store/messageQueue'
import { continuationError } from './agent/taskContinuation'
import { parseAcceptance, verifyAcceptance } from './tasks/acceptance'
import { getSettings } from './settings'
import { manageRoutineTaskResult } from './routines/notifications'
import { MAX_CONCURRENT_RUNS, MAX_QUEUED_TASKS, MAX_QUEUED_TASKS_PER_BOT } from './tasks/limits'
import { saveTaskMessages, setTaskMessageStatus, taskMessages } from './tasks/messages'
import { steerCodexTurn } from './backends/cli/codexAppServer'
import { liveMessages } from './agent/liveMessages'
import { scrubVaultTranscript } from './store/vaultPrivacy'
import { dependencyState, parseTaskPlan, rankQueuedTasks, validateDependencyGraph } from './tasks/planning'
import { prepareTaskWorkspace, taskWorkspaceKey, workspaceInstructions } from './tasks/workspaces'
import { forgetBindingsForSession } from './store/providerBindings'

/**
 * How many background runs may be live at once.
 *
 * Each one is a model stream plus tool execution with the user's permissions,
 * so "start every task the moment it is created" was never a policy: a ten-bot
 * group broadcast fired ten simultaneous agents, and a model calling
 * `delegate_task` in a loop added one more per iteration of a single turn.
 * Everything past this limit waits in 'queued' — the status the record already
 * carried and the UI already renders, but which nothing ever honoured.
 */

/**
 * Waiting capacity is independent of the four execution slots. These are
 * large storage bounds; queued records never consume an execution slot.
 */

/** Ids of queued tasks waiting for a slot, oldest first. */
const waiting: string[] = []
let running = 0
const runningSessions = new Set<string>()
const runningWorkspaces = new Set<string>()
const lastStartedByBot = new Map<string, number>()
let retryTimer: ReturnType<typeof setTimeout> | undefined
const inboxActive = new Set<string>()
let inboxInstalled = false
const decisions = new Map<string, Promise<void>>()
const removingBots = new Set<string>()
/** Read-only admission state for side-effect claims while deletion is pending. */
export function isBotBeingRemoved(botId: string): boolean { return removingBots.has(botId) }
/** Executable supplemental text is memory-only; restart never replays it. */
const messageBodies = new Map<string, string>()
const taskStopGenerations = new Map<string, number>()

interface ResumeProof {
  taskId: string
  updatedAt: number
  status: AgentTask['status']
  sourceSessionId: string
  callerSessionId: string
  botId: string
  sourceGeneration: number
  callerGeneration: number
  taskStopGeneration: number
  signal: AbortSignal
}

function needsResumeConfirmation(task: AgentTask): boolean { return task.status === 'cancelled' || taskExecutionWasInterrupted(task) }

function validateResumeProof(task: AgentTask, proof: ResumeProof | undefined, sourceSessionId: string, botId: string): void {
  if (!proof || proof.taskId !== task.id || proof.updatedAt !== task.updatedAt || proof.status !== task.status || proof.sourceSessionId !== sourceSessionId || proof.botId !== botId || proof.signal.aborted || proof.sourceGeneration !== queueSuspensionGeneration(sourceSessionId) || proof.callerGeneration !== queueSuspensionGeneration(proof.callerSessionId) || proof.taskStopGeneration !== (taskStopGenerations.get(task.id) ?? 0)) throw new TypeError('The task recovery confirmation is missing or stale; no execution was resumed.')
  managementCaller(proof.callerSessionId, botId)
}

function assertBotAdmission(...botIds: string[]): void {
  if (botIds.some(id => removingBots.has(id))) throw new Error('This bot is being removed; no new work was started.')
}

/** Fence admission before awaiting cancellation; the remover releases on every exit. */
export async function prepareBotTaskRemoval(botId: string): Promise<() => void> {
  if (removingBots.has(botId)) throw new Error('This bot is already being removed.')
  removingBots.add(botId)
  const release = () => { removingBots.delete(botId) }
  try {
    await withTaskDecision('admission:global', async () => {
      for (const task of listTasks()) if ((task.botId === botId || task.requesterBotId === botId) && (task.status === 'queued' || task.status === 'running')) await cancelBackgroundTask(task.id)
      await durable()
    })
    return release
  } catch (error) { release(); throw error }
}

async function withTaskDecision<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = decisions.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  decisions.set(id, current)
  await previous
  try { return await work() } finally { release(); if (decisions.get(id) === current) decisions.delete(id) }
}

/** Results survive restart. Only pending (never uncertain) receipts are retried. */
export function installTaskInbox(): void {
  if (inboxInstalled) return
  inboxInstalled = true
  onAgentEvent((event) => {
    if (event.type === 'done') void drainTaskInbox(event.sessionId)
    if (event.type === 'session-updated') void drainTaskInbox(event.session.id)
    if (event.type === 'message-queue-updated' && !event.queue.items.length) void drainTaskInbox(event.queue.sessionId)
  })
  const snapshot = listTasks()
  const continued = new Set(snapshot.filter(task => task.continuedFromTaskId).map(task => JSON.stringify([task.continuedFromTaskId, task.sourceSessionId])))
  const interrupted = new Map<string, { task: AgentTask; count: number }>()
  for (const task of snapshot) {
    if (task.sourceSessionId && task.deliveryStatus === 'pending') void drainTaskInbox(task.sourceSessionId)
    else if (task.sourceSessionId && task.deliveryStatus === 'uncertain' && task.status !== 'cancelled') {
      const decided = Boolean(task.review) || continued.has(JSON.stringify([task.id, task.sourceSessionId]))
      if (decided) {
        // A durable assessment/continuation lets the inbox finish the receipt
        // without asking the lead to run again after a crash.
        updateTaskDelivery(task.id, 'pending')
        void drainTaskInbox(task.sourceSessionId)
      } else {
        const key = JSON.stringify([task.sourceSessionId, task.requesterBotId ?? task.botId])
        const group = interrupted.get(key)
        interrupted.set(key, { task: group?.task ?? task, count: (group?.count ?? 0) + 1 })
      }
    }
  }
  for (const { task, count } of interrupted.values()) void reportToSource(task, count === 1 ? agentProgressReport(agentProgressName(task.title, getSession(task.sessionId)?.title), '结果送达待确认，请核对。') : `${agentProgressName(task.title, getSession(task.sessionId)?.title)} 等 ${count} 个任务：执行中断或结果待确认，未自动重跑。`, true)
}

async function durable(): Promise<void> {
  const result = await flushAll()
  if (result.failed.length || result.stillWriting) throw new Error('Could not persist the background result safely.')
}

async function drainTaskInbox(sessionId: string): Promise<void> {
  if (inboxActive.has(sessionId) || isRunning(sessionId) || isStarting(sessionId) || isQueueDraining(sessionId) || isQueueSuspended(sessionId) || hasPendingQueueWrite(sessionId) || getMessageQueue(sessionId).items.length) return
  const task = listTasks().filter((item) => item.sourceSessionId === sessionId && item.deliveryStatus === 'pending').sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!task || task.result === undefined) return
  if (removingBots.has(task.botId) || removingBots.has(task.requesterBotId ?? task.botId)) return
  const source = getSession(sessionId)
  if (!source || source.archived) {
    announce(updateTaskDelivery(task.id, 'uncertain'))
    await durable().catch((error) => console.error('[openbot/inbox] could not save unavailable source', error))
    return
  }
  if (source.activeBotId !== (task.requesterBotId ?? task.botId) || source.mode !== 'agent') return
  inboxActive.add(sessionId)
  let reserved = false
  let invoked = false
  let releaseRoutineNotifications = () => {}
  try {
    await durable()
    await reportToSource(task, agentProgressReport(agentProgressName(task.title, getSession(task.sessionId)?.title), task.status === 'completed' ? '已返回结果，待核对。' : taskExecutionWasInterrupted(task) ? '执行已中断，未自动重跑。' : '执行失败，请核对已有结果。'))
    if (isRunning(sessionId) || isStarting(sessionId) || isQueueDraining(sessionId) || isQueueSuspended(sessionId) || hasPendingQueueWrite(sessionId) || getMessageQueue(sessionId).items.length) return
    // Reserve synchronously before the next await. User sends then see a busy
    // chat and are safely accepted by the normal follow-up delivery path.
    reserveStart(sessionId)
    reserved = true
    broadcast({ type: 'run-started', sessionId })
    announce(updateTaskDelivery(task.id, 'delivering'))
    await durable()
    const receive = await loopFn('receiveAgentResult')
    if (!receive) throw new Error('The lead runtime is unavailable.')
    if (isStartCancelled(sessionId)) throw new Error('Result delivery was stopped before the lead started.')
    releaseRoutineNotifications = await manageRoutineTaskResult(task.id, sessionId)
    const receiver = getSession(sessionId)
    if (!receiver || receiver.archived || receiver.mode !== 'agent' || receiver.activeBotId !== (task.requesterBotId ?? task.botId)) {
      announce(updateTaskDelivery(task.id, !receiver || receiver.archived ? 'uncertain' : 'pending'))
      await durable()
      return
    }
    invoked = true
    const accepted = await receive(sessionId, task.id, task.title, task.result, async () => {
      updateTaskDelivery(task.id, 'delivered')
      await durable()
      announce(getTask(task.id))
    })
    if (!accepted) { updateTaskDelivery(task.id, 'pending'); await durable(); announce(getTask(task.id)) }
  } catch (error) {
    console.error('[openbot/inbox] could not confirm result delivery', error)
    announce(updateTaskDelivery(task.id, 'uncertain'))
    await durable().catch(console.error)
    await reportToSource(task, agentProgressReport(agentProgressName(task.title, getSession(task.sessionId)?.title), '结果送达待确认，请核对。'), true).catch(console.error)
  } finally {
    if (reserved) releaseStart(sessionId)
    if (reserved && !invoked && !isRunning(sessionId)) broadcast({ type: 'done', sessionId })
    releaseRoutineNotifications()
    inboxActive.delete(sessionId)
    if (!isRunning(sessionId) && listTasks().some((item) => item.sourceSessionId === sessionId && item.deliveryStatus === 'pending')) setTimeout(() => void drainTaskInbox(sessionId), 500).unref?.()
  }
}

function announce(task: AgentTask | null): AgentTask | null {
  if (task) broadcast({ type: 'task-updated', task })
  return task
}

/**
 * Announce a task that reached a terminal status, then bound what is kept.
 *
 * Every task owns a session, so an untrimmed tasks collection is also an
 * unbounded pile of session files — all of them read into memory at boot. The
 * trim returns the sessions it archived so the open windows stay in step.
 */
function settle(task: AgentTask | null): AgentTask | null {
  announce(task)
  for (const session of trimTasks()) broadcast({ type: 'session-updated', session })
  return task
}

export async function startBackgroundTask(botId: string, prompt: string, title = prompt.slice(0, 80)): Promise<AgentTask> {
  return withTaskDecision('admission:global', async () => {
  assertBotAdmission(botId)
  const bot = getBot(botId)
  if (!bot || bot.archived) throw new TypeError('That bot no longer exists.')
  const body = prompt.trim().slice(0, 100_000)
  if (!body) throw new TypeError('A background task needs a prompt.')
  if (countQueuedTasks() >= MAX_QUEUED_TASKS) {
    throw new TypeError(`Too much background work is already queued (${MAX_QUEUED_TASKS} waiting tasks). Wait for some to start, or cancel a few.`)
  }
  if (countQueuedTasks(botId) >= MAX_QUEUED_TASKS_PER_BOT) {
    throw new TypeError(`${bot.name} already has ${MAX_QUEUED_TASKS_PER_BOT} background tasks waiting.`)
  }
  const label = title.trim().slice(0, 200) || 'Background task'
  // The home owns the result, while the work owns a private conversation.
  // Snapshot the execution config without rewriting an existing Bot's setup.
  const source = ensureBotHome(botId)
  if (!source || source.mode !== 'agent') throw new TypeError('后台执行需要可用的执行模式主聊天。')
  const plan = parseTaskPlan(undefined, source.cwd, source.id, botId, listTasks())
  const session = saveSession({ ...createSession([botId], source.cwd), archived: true, cwd: source.cwd, mode: source.mode, title: 'Background execution', ...(source.projectId ? { projectId: source.projectId } : {}) })
  await durable()
  const executionAgent = bot.executionAgent ?? { backendId: bot.backendId, modelId: bot.modelId, ...(bot.thinking ? { thinking: bot.thinking } : {}) }
  const task = await createTaskRecordDurable(botId, session.id, body, label, { sourceSessionId: source.id, executionAgent: { ...executionAgent }, plan, sessionChoice: { mode: 'new', reason: plan.sessionReason } })
  broadcast({ type: 'session-updated', session: source })
  announce(task)
  waiting.push(task.id)
  pump()
  return task
  })
}

/** A bot may delegate only to a teammate the user put in this conversation. */
export async function delegateBackgroundTask(
  sourceSessionId: string,
  fromBotId: string,
  toBotId: string,
  prompt: string,
  title?: string,
  continueTaskId?: string,
  signal?: AbortSignal,
  outputFiles?: unknown,
  plan?: TaskPlanInput
): Promise<AgentTask> {
  const task = await createDelegatedTask(sourceSessionId, fromBotId, toBotId, prompt, title, continueTaskId, signal, outputFiles, undefined, plan)
  await dispatchNotice(task, sourceSessionId, fromBotId)
  return task
}

async function dispatchNotice(task: AgentTask, sourceSessionId: string, fromBotId: string): Promise<void> {
  // A notice failure cannot turn an already-created task into a failed tool
  // call: retrying that call could otherwise start the work twice.
  try {
    const source = await sessions.get(sourceSessionId)
    if (source) await addNotice(source, getBot(fromBotId), agentProgressReport(agentProgressName(task.title, getSession(task.sessionId)?.title), getSettings().language === 'en' ? 'Dispatched.' : '已派发。'), undefined, `agent-dispatch-${task.id}`, true)
  } catch (error) { console.warn('[openbot/tasks] dispatch notice could not be saved', error) }
}

async function createDelegatedTask(
  sourceSessionId: string,
  fromBotId: string,
  toBotId: string,
  prompt: string,
  title?: string,
  continueTaskId?: string,
  signal?: AbortSignal,
  outputFiles?: unknown,
  resumeProof?: ResumeProof,
  planInput?: TaskPlanInput
): Promise<AgentTask> {
  const source = getSession(sourceSessionId)
  if (!source) throw new TypeError('The source conversation no longer exists.')
  if (!source.botIds.includes(fromBotId) || !source.botIds.includes(toBotId)) {
    throw new TypeError('Delegation is limited to bots already in this conversation.')
  }
  if (continueTaskId) {
    return withTaskDecision(`task:${continueTaskId}`, () => withTaskDecision('admission:global', async () => {
      const currentSource = getSession(sourceSessionId)
      assertBotAdmission(fromBotId, toBotId)
      if (signal?.aborted) throw new Error('Delegation was stopped before it started.')
      if (!currentSource || currentSource.archived || currentSource.mode !== 'agent' || !currentSource.botIds.includes(fromBotId) || !currentSource.botIds.includes(toBotId)) throw new TypeError('Background execution is only available in the active source conversation.')
      const previous = getTask(continueTaskId)
      if (previous && (needsResumeConfirmation(previous) || resumeProof)) validateResumeProof(previous, resumeProof, sourceSessionId, fromBotId)
      const error = continuationError(previous, listTasks(), sourceSessionId, fromBotId, toBotId, Boolean(resumeProof))
      if (error || !previous) throw new TypeError(error ?? 'The execution agent is unavailable.')
      if (previous.acceptanceInvalid) throw new TypeError('The saved output checks are invalid and cannot be changed by a continuation.')
      if (previous.planInvalid) throw new TypeError('The saved task plan is invalid; inspect its retained work before continuing.')
      if (outputFiles !== undefined && (!previous.acceptance || JSON.stringify(parseAcceptance(previous.acceptance.root, outputFiles)) !== JSON.stringify(previous.acceptance))) throw new TypeError('A continuation cannot change the original output checks.')
      if (!currentSource.botIds.includes(previous.botId) || !getBot(previous.botId) || getBot(previous.botId)?.archived) throw new TypeError('The original execution Bot is no longer available in this conversation.')
      const body = prompt.trim().slice(0, 100_000)
      if (!body) throw new TypeError('A continuation needs the remaining work.')
      if (countQueuedTasks() >= MAX_QUEUED_TASKS || countQueuedTasks(previous.botId) >= MAX_QUEUED_TASKS_PER_BOT) throw new TypeError('Too many background tasks are already waiting in the queue.')
      const continuation = 'Continue the previously delegated task in this same conversation. Previous actions may already have happened; inspect the actual state before repeating any command, file change, or external effect. Remaining work:\n\n' + body
      const sourceGeneration = queueSuspensionGeneration(sourceSessionId), stopGeneration = taskStopGenerations.get(previous.id) ?? 0
      const changedWorkspace = planInput?.workspace !== undefined && planInput.workspace !== 'auto'
      const sourceCwd = planInput?.workspace === 'isolated' ? previous.workspace?.path ?? getSession(previous.sessionId)?.cwd ?? currentSource.cwd : previous.plan?.sourceCwd ?? getSession(previous.sessionId)?.cwd ?? currentSource.cwd
      const plan = previous.plan || planInput ? parseTaskPlan(planInput, sourceCwd, sourceSessionId, fromBotId, listTasks(), previous) : undefined
      const task = await createTaskRecordDurable(previous.botId, previous.sessionId, continuation, title?.trim().slice(0, 200) || previous.title, { sourceSessionId, ...(previous.requesterBotId ? { requesterBotId: previous.requesterBotId } : {}), ...(previous.executionAgent ? { executionAgent: { ...previous.executionAgent } } : {}), ...(previous.acceptance ? { acceptance: previous.acceptance } : {}), continuedFromTaskId: previous.id, ...(plan ? { plan } : {}), ...(!changedWorkspace && previous.workspace ? { workspace: previous.workspace } : {}), sessionChoice: { mode: 'continue', previousTaskId: previous.id, reason: plan?.sessionReason ?? 'Continue the same task in its original execution conversation.' } })
      try {
        assertBotAdmission(fromBotId, previous.botId)
        const freshSource = getSession(sourceSessionId), lead = getBot(fromBotId), worker = getBot(previous.botId)
        if (signal?.aborted || queueSuspensionGeneration(sourceSessionId) !== sourceGeneration || (taskStopGenerations.get(previous.id) ?? 0) !== stopGeneration || !freshSource || freshSource.archived || freshSource.mode !== 'agent' || !freshSource.botIds.includes(fromBotId) || !freshSource.botIds.includes(previous.botId) || !lead || lead.archived || !worker || worker.archived) throw new Error('The source or stop state changed while recovery was being saved; no executor was started.')
        if (resumeProof) validateResumeProof(getTask(previous.id) ?? previous, resumeProof, sourceSessionId, fromBotId)
      } catch (error) {
        announce(cancelAgentTask(task.id))
        await durable()
        throw error
      }
      announce(task)
      waiting.push(task.id)
      pump()
      return task
    }))
  }
  const acceptance = outputFiles === undefined ? undefined : parseAcceptance(source.cwd, outputFiles)
  if (fromBotId !== toBotId) return withTaskDecision('admission:global', async () => {
    assertBotAdmission(fromBotId, toBotId)
    const current = getSession(sourceSessionId), teammate = getBot(toBotId)
    if (signal?.aborted) throw new Error('Delegation was stopped before it started.')
    if (!current || current.archived || current.mode !== 'agent' || !current.botIds.includes(fromBotId) || !current.botIds.includes(toBotId) || !teammate || teammate.archived) throw new TypeError('The teammate is no longer available in this conversation.')
    if (acceptance && parseAcceptance(current.cwd, outputFiles).root !== acceptance.root) throw new TypeError('The workspace changed before delegation; check the output paths again.')
    const body = prompt.trim().slice(0, 100_000)
    if (!body) throw new TypeError('A background task needs a prompt.')
    if (countQueuedTasks() >= MAX_QUEUED_TASKS || countQueuedTasks(toBotId) >= MAX_QUEUED_TASKS_PER_BOT) throw new TypeError('Too many background tasks are already waiting in the queue.')
    const plan = parseTaskPlan(planInput, current.cwd, sourceSessionId, fromBotId, listTasks())
    const session = saveSession({ ...createSession([toBotId], current.cwd), archived: true, cwd: current.cwd, mode: current.mode, title: 'Teammate execution', ...(current.projectId ? { projectId: current.projectId } : {}) })
    await durable()
    if (signal?.aborted) throw new Error('Delegation was stopped before it started.')
    const task = await createTaskRecordDurable(toBotId, session.id, body, title?.trim().slice(0, 200) || body.slice(0, 80), { sourceSessionId, requesterBotId: fromBotId, ...(acceptance ? { acceptance } : {}), plan, sessionChoice: { mode: 'new', reason: plan.sessionReason } })
    if (signal?.aborted) { announce(setTaskStatus(task.id, 'cancelled')); await durable(); throw new Error('Delegation was stopped before it started.') }
    announce(task); waiting.push(task.id); pump()
    return task
  })
  const bot = getBot(fromBotId)
  if (!bot?.executionAgent) throw new TypeError('Configure this bot’s independent execution agent first.')
  if (source.archived || source.mode !== 'agent') throw new TypeError('Background execution is only available in an active Agent-mode chat.')
  const body = prompt.trim().slice(0, 100_000)
  if (!body) throw new TypeError('A background task needs a prompt.')
  return withTaskDecision('admission:global', async () => {
    assertBotAdmission(fromBotId, toBotId)
    const currentSource = getSession(sourceSessionId)
    if (signal?.aborted) throw new Error('Delegation was stopped before it started.')
    if (!currentSource || currentSource.archived || currentSource.mode !== 'agent' || !currentSource.botIds.includes(fromBotId)) throw new TypeError('The source conversation is no longer available.')
    if (acceptance && parseAcceptance(currentSource.cwd, outputFiles).root !== acceptance.root) throw new TypeError('The workspace changed before delegation; check the output paths again.')
    if (countQueuedTasks() >= MAX_QUEUED_TASKS || countQueuedTasks(fromBotId) >= MAX_QUEUED_TASKS_PER_BOT) throw new TypeError('Too many background tasks are already waiting in the queue.')
    const plan = parseTaskPlan(planInput, currentSource.cwd, sourceSessionId, fromBotId, listTasks())
    const session = saveSession({ ...createSession([fromBotId], currentSource.cwd), archived: true, cwd: currentSource.cwd, mode: currentSource.mode, title: 'Background execution', ...(currentSource.projectId ? { projectId: currentSource.projectId } : {}) })
    // The private session must exist before its task can become durable.
    await durable()
    if (signal?.aborted) throw new Error('Delegation was stopped before it started.')
    const task = await createTaskRecordDurable(fromBotId, session.id, body, title?.trim().slice(0, 200) || body.slice(0, 80), { sourceSessionId, executionAgent: { ...bot.executionAgent! }, ...(acceptance ? { acceptance } : {}), plan, sessionChoice: { mode: 'new', reason: plan.sessionReason } })
    if (signal?.aborted) { announce(setTaskStatus(task.id, 'cancelled')); await durable(); throw new Error('Delegation was stopped before it started.') }
    announce(task)
    waiting.push(task.id)
    pump()
    return task
  })
}

function managementCaller(sessionId: string, botId: string): void {
  assertBotAdmission(botId)
  const session = getSession(sessionId), bot = getBot(botId)
  if (!session || !bot || bot.archived || session.mode !== 'agent' || !session.botIds.includes(botId)) throw new TypeError('The task manager is unavailable for this conversation and bot.')
}

/** Historical/archived executor identity survives terminal tasks and trimming. */
function privateExecutorSession(sessionId: string): boolean {
  return Boolean(getSession(sessionId)?.archived || listTasks().some(value => value.sourceSessionId && value.sessionId === sessionId))
}

function taskForInspection(task: AgentTask): AgentTask {
  return { ...task, title: scrubVaultTranscript(task.title), prompt: scrubVaultTranscript(task.prompt), ...(task.result === undefined ? {} : { result: scrubVaultTranscript(task.result) }), ...(task.error === undefined ? {} : { error: scrubVaultTranscript(task.error) }), ...(task.review ? { review: { ...task.review, summary: scrubVaultTranscript(task.review.summary), evidence: task.review.evidence.map(scrubVaultTranscript) } } : {}) }
}

function managedTask(sessionId: string, botId: string, taskId: string): AgentTask {
  managementCaller(sessionId, botId)
  const task = getTask(taskId)
  if (!task || ((task.requesterBotId ?? task.botId) !== botId && !(task.botId === botId && task.sessionId === sessionId)) || (privateExecutorSession(sessionId) && task.sessionId !== sessionId)) throw new TypeError('That task does not belong to this bot, or is outside this executor’s scope.')
  const source = getSession(task.sourceSessionId ?? task.sessionId)
  if (!source?.botIds.includes(botId)) throw new TypeError('The original lead is no longer a member of the source conversation.')
  return task
}

/** One Bot owns its tasks across its chats; an executor only manages its own task. */
export async function manageBackgroundTask(sessionId: string, botId: string, command: AgentTaskCommand, signal?: AbortSignal, confirmResume?: (task: AgentTask) => Promise<boolean>): Promise<Record<string, unknown>> {
  managementCaller(sessionId, botId)
  if (signal?.aborted) throw new Error('Task management was stopped.')
  if (command.action === 'list') {
    const executor = privateExecutorSession(sessionId)
    const owned = listTasks().filter(value => ((value.requesterBotId ?? value.botId) === botId || value.sessionId === sessionId && value.botId === botId) && (!executor || value.sessionId === sessionId)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    const offset = command.before ? owned.findIndex(value => value.id === command.before) + 1 : 0
    if (command.before && offset === 0) throw new TypeError('The task cursor is unavailable.')
    const limit = Math.max(1, Math.min(100, Math.trunc(command.limit ?? 20)))
    const tasks = owned.slice(offset, offset + limit).map(value => summariseTask(taskForInspection(value)))
    return { tasks, total: owned.length, next: offset + tasks.length < owned.length ? tasks.at(-1)?.id : undefined, note: 'Returned status describes execution, not acceptance of the user objective. Inspect a suitable task before messaging or reusing its original session.' }
  }
  if (!command.taskId?.trim()) throw new TypeError('Provide the exact task id.')
  const task = managedTask(sessionId, botId, command.taskId)
  if (command.action === 'prioritize') {
    if (privateExecutorSession(sessionId)) throw new TypeError('Only the owning lead can change queued work. Report the proposed change instead.')
    return withTaskDecision(`task:${task.id}`, async () => {
      const current = managedTask(sessionId, botId, task.id)
      if (current.status !== 'queued') throw new TypeError('Only queued work can be reprioritized; running tasks keep their execution.')
      if (!current.sourceSessionId) throw new TypeError('This legacy task needs its original ownership checked before changing its plan.')
      const reason = command.reason?.trim()
      if (!reason || reason.length > 2000) throw new TypeError('Provide a short reason grounded in the user’s current priorities.')
      const cwd = current.plan?.sourceCwd ?? getSession(current.sessionId)?.cwd
      if (!cwd) throw new TypeError('The source workspace is unavailable.')
      const base = current.plan ? current : { ...current, plan: parseTaskPlan({ workspace: 'shared', workspace_reason: 'Retain the existing task directory; a priority change does not migrate data.' }, cwd, current.sourceSessionId, botId, listTasks()) }
      const plan = parseTaskPlan({ ...(command.priority !== undefined ? { priority: command.priority } : {}), ...(command.dependencies !== undefined ? { depends_on: command.dependencies } : {}), priority_reason: reason }, cwd, current.sourceSessionId, botId, listTasks(), base)
      validateDependencyGraph(current.id, plan.dependencies, listTasks())
      if (signal?.aborted) throw new Error('The queue change was stopped.')
      const saved = await saveTaskRuntimeDurable(current.id, { plan })
      announce(saved); pump()
      return { task: summariseTask(taskForInspection(saved)), priority: plan.priority, dependencies: plan.dependencies, reason: plan.priorityReason, note: 'Queued work was updated. Running work was not interrupted; output and task identity are unchanged.' }
    })
  }
  if (command.action === 'resume') {
    if (!task.sourceSessionId) throw new TypeError('This legacy task has no independent execution session to resume. Inspect its conversation before starting further work.')
    if (!command.text?.trim()) throw new TypeError('A resume needs explicit remaining work and instructions to inspect prior effects before repeating anything.')
    if (listTasks().some(value => value.continuedFromTaskId === task.id)) throw new TypeError('This task result already has a continuation.')
    let proof: ResumeProof | undefined
    if (needsResumeConfirmation(task)) {
      if (!confirmResume || !signal) throw new TypeError('A cancelled or interrupted task requires a fresh user confirmation to resume.')
      const snapshot: ResumeProof = { taskId: task.id, updatedAt: task.updatedAt, status: task.status, sourceSessionId: task.sourceSessionId, callerSessionId: sessionId, botId, sourceGeneration: queueSuspensionGeneration(task.sourceSessionId), callerGeneration: queueSuspensionGeneration(sessionId), taskStopGeneration: taskStopGenerations.get(task.id) ?? 0, signal }
      // A real user gate lives outside the task/admission locks. While it is
      // pending, stop/delete/another assessment must remain responsive.
      if (!await confirmResume(taskForInspection(task))) throw new TypeError('Task recovery was not approved; it remains stopped.')
      proof = snapshot
    }
    // The private creation path validates this server-created proof again under
    // both locks. There is no model argument, message id or Boolean override.
    const next = await createDelegatedTask(task.sourceSessionId, botId, task.botId, command.text, task.title, task.id, signal, undefined, proof)
    await dispatchNotice(next, task.sourceSessionId, botId)
    return { task: summariseTask(next), resumedFromTaskId: task.id, sameSession: next.sessionId === task.sessionId, note: 'A new attempt was explicitly requested; inspect previous actions before repeating them. The previous attempt remains unchanged.' }
  }
  if (command.action === 'stop') {
    const stopped = await cancelBackgroundTask(task.id)
    return { task: stopped ? summariseTask(stopped) : null, stopped: stopped?.status === 'cancelled', executorStillCleaningUp: runningSessions.has(task.sessionId), note: 'Cancellation was requested. Cleanup may still be finishing and retains its execution slot; prior effects are not undone. Resume requires an explicit new command.' }
  }
  return withTaskDecision(`task:${task.id}`, async () => {
    const current = managedTask(sessionId, botId, task.id)
    if (signal?.aborted) throw new Error('Task management was stopped.')
    if (command.action === 'inspect') {
      const session = getSession(current.sessionId)
      const recent = [...(session?.messages ?? []), ...liveMessages(current.sessionId)].filter(value => !value.internal && !value.uiOnly).slice(-12).map(value => ({ id: value.id, role: value.role, content: scrubVaultTranscript((value.displayContent ?? value.content).slice(-6000)), error: value.error ? scrubVaultTranscript(value.error) : undefined, streaming: value.streaming }))
      return { task: taskForInspection(current), scheduling: dependencyState(current, listTasks()), recent, todos: session?.todos.map(value => ({ ...value, text: scrubVaultTranscript(value.text) })) ?? [], messages: await taskMessages(current.id), note: 'Progress and executor output are observations. Check original requirements and independent evidence before review_task.' }
    }
    const text = command.text?.trim().slice(0, 30_000)
    if (!text || !command.requestId?.trim() || command.requestId.length > 160) throw new TypeError('Provide text and a stable request_id (at most 160 characters); reuse that id when checking delivery after a timeout.')
    const messages = await taskMessages(current.id)
    const fingerprint = createHash('sha256').update(text).digest('hex')
    const existing = messages.find(value => value.requestId === command.requestId)
    if (existing) {
      if (existing.fingerprint ? existing.fingerprint !== fingerprint : existing.text !== text) throw new TypeError('This request_id already refers to a different message.')
      return { receipt: existing, duplicate: true }
    }
    if (!['queued', 'running'].includes(current.status)) throw new TypeError('The executor has returned. Inspect the result and use resume for authorized remaining work.')
    const receipt: AgentTaskMessageReceipt = { requestId: command.requestId, taskId: current.id, text: scrubVaultTranscript(text), fingerprint, direction: command.action === 'report' ? 'to_lead' : 'to_executor', status: 'queued', createdAt: Date.now(), updatedAt: Date.now() }
    if (command.action === 'report') {
      if (sessionId !== current.sessionId || !current.sourceSessionId) throw new TypeError('Only an independent task’s executor can report its milestone.')
      const previous = messages.filter(value => value.direction === 'to_lead' && value.status === 'delivered').at(-1)
      if (previous && previous.fingerprint === fingerprint && Date.now() - previous.updatedAt < 300_000) return { receipt: previous, duplicate: true }
      if (previous && Date.now() - previous.updatedAt < 10_000) return { reported: false, throttled: true, retryAfterMs: 10_000 - (Date.now() - previous.updatedAt), note: 'Avoid repeated milestone updates; report a meaningful change after this short interval.' }
      await saveTaskMessages(current.id, [...messages, { ...receipt, status: 'delivering' }])
      try {
        await reportToSource(current, agentProgressReport(agentProgressName(current.title, getSession(current.sessionId)?.title), text), false, `milestone-${command.requestId}`)
        await setTaskMessageStatus(current.id, [receipt.requestId], 'delivered')
        recordTaskMilestone(current.id, receipt.requestId)
        announce(getTask(current.id))
      } catch (error) { await setTaskMessageStatus(current.id, [receipt.requestId], 'uncertain'); throw error }
      return { receipt: (await taskMessages(current.id)).find(value => value.requestId === receipt.requestId), note: 'The milestone was saved in the lead chat. This is not task completion.' }
    }
    if (command.action !== 'message') throw new TypeError('Unknown task action.')
    if (sessionId === current.sessionId) throw new TypeError('An executor cannot send instructions to itself; report a milestone instead.')
    messageBodies.set(`${current.id}:${receipt.requestId}`, text)
    await saveTaskMessages(current.id, [...messages, receipt])
    if (current.status === 'running') {
      await setTaskMessageStatus(current.id, [receipt.requestId], 'delivering')
      try {
        const steered = await steerCodexTurn(current.sessionId, text, async () => {
          const session = await sessions.get(current.sessionId)
          if (!session) throw new Error('The execution conversation is unavailable after delivery.')
          await addUserMessage(session, text, undefined, true, `task-message-${current.id}-${receipt.requestId}`, receipt.createdAt)
          await durable()
          await setTaskMessageStatus(current.id, [receipt.requestId], 'delivered', 'live')
        })
        if (!steered) await setTaskMessageStatus(current.id, [receipt.requestId], 'queued')
        else messageBodies.delete(`${current.id}:${receipt.requestId}`)
      } catch {
        // The remote turn may have received the request. An uncertain RPC is never retried.
        await setTaskMessageStatus(current.id, [receipt.requestId], 'uncertain')
        messageBodies.delete(`${current.id}:${receipt.requestId}`)
      }
    }
    const saved = (await taskMessages(current.id)).find(value => value.requestId === receipt.requestId)!
    return { receipt: saved, note: saved.status === 'delivered' ? 'The active executor acknowledged delivery; this does not prove it followed the instruction.' : saved.status === 'queued' ? 'Saved for this same execution session at its next safe turn boundary; live delivery has not been confirmed.' : 'Delivery is uncertain. Inspect the executor; do not resend under a new request_id.' }
  })
}

/** A review is scoped to its lead and records a claim, not objective proof. */
export async function reviewBackgroundTask(sessionId: string, botId: string, taskId: string, outcome: 'complete_claimed' | 'blocked', summary: string, evidence: string[], signal?: AbortSignal): Promise<AgentTask> {
  return withTaskDecision(`task:${taskId}`, async () => {
    if (signal?.aborted) throw new Error('The assessment was stopped before it was saved.')
    const task = getTask(taskId)
    if (!task || task.sourceSessionId !== sessionId || (task.requesterBotId ?? task.botId) !== botId || (!task.executionAgent && !task.requesterBotId)) throw new TypeError('That task does not belong to this conversation and bot.')
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) throw new TypeError('The executor has not returned yet.')
    if (task.review) {
      if (task.review.outcome !== outcome || task.review.summary !== summary || JSON.stringify(task.review.evidence) !== JSON.stringify(evidence)) throw new TypeError('This task already has a different assessment.')
      const saved = await storeTaskReviewDurable(taskId, task.review)
      if (!saved) throw new Error('The task no longer exists.')
      return saved
    }
    if (listTasks().some((other) => other.continuedFromTaskId === taskId)) throw new TypeError('This task already has a continuation; review the latest result instead.')
    if (outcome === 'complete_claimed' && (task.status !== 'completed' || !evidence.length)) throw new TypeError('A completion claim requires a returned result and supporting evidence.')
    if (outcome === 'complete_claimed' && task.acceptanceInvalid) throw new TypeError('Saved output checks are invalid; this task cannot be marked complete.')
    const verifiedFiles = outcome === 'complete_claimed' && task.acceptance ? await verifyAcceptance({ ...task.acceptance, root: task.workspace?.path ?? task.acceptance.root }, signal) : undefined
    if (signal?.aborted) throw new Error('The assessment was stopped before it was saved.')
    const recordedAt = Date.now()
    const saved = await storeTaskReviewDurable(taskId, { outcome, summary, evidence, recordedAt, ...(verifiedFiles ? { verifiedFiles } : {}) })
    if (!saved) throw new Error('The task no longer exists.')
    announce(saved)
    return saved
  })
}

export async function cancelBackgroundTask(id: string): Promise<AgentTask | null> {
  const task = getTask(id)
  if (!task) return null
  taskStopGenerations.set(task.id, (taskStopGenerations.get(task.id) ?? 0) + 1)
  if (!['queued', 'running'].includes(task.status)) {
    if (task.status === 'cancelled' && (runningSessions.has(task.sessionId) || isRunning(task.sessionId))) {
      const stop = await loopFn('stopSession')
      if (!stop) throw new Error('The executor runtime is unavailable; stopping has not been confirmed.')
      await stop(task.sessionId)
    }
    return task
  }
  /*
   * A queued task holds no session run yet, so dropping it from the queue is
   * the whole job — and `pump` re-reads the record before starting anything,
   * which is what makes "cancel" mean "never starts" rather than "starts and
   * is stopped a moment later".
   */
  const position = waiting.indexOf(task.id)
  if (position >= 0) waiting.splice(position, 1)
  // Set the terminal status before awaiting stop so the running continuation
  // cannot observe an aborted task as successful.
  const cancelled = settle(task.sourceSessionId ? cancelAgentTask(task.id) : setTaskStatus(task.id, 'cancelled'))
  if (task.status === 'running') {
    const stop = await loopFn('stopSession')
    if (!stop) throw new Error('The executor runtime is unavailable; stopping has not been confirmed.')
    await stop(task.sessionId)
  }
  await withTaskDecision(`task:${task.id}`, async () => {
    const pending = (await taskMessages(task.id)).filter(value => value.status === 'queued')
    if (pending.length) await setTaskMessageStatus(task.id, pending.map(value => value.requestId), 'cancelled')
  })
  if (cancelled) await durable()
  return cancelled
}

/** Start queued tasks while the pool has room. Safe to call at any time. */
function pump(): void {
  const all = listTasks(), byId = new Map(all.map(task => [task.id, task]))
  for (let index = waiting.length - 1; index >= 0; index--) if (byId.get(waiting[index]!)?.status !== 'queued') waiting.splice(index, 1)
  const ranked = rankQueuedTasks(waiting.flatMap(id => byId.get(id) ? [byId.get(id)!] : []), Date.now(), lastStartedByBot)
  for (const task of ranked) {
    if (running >= MAX_CONCURRENT_RUNS) break
    const id = task.id
    if (task.planInvalid) { waiting.splice(waiting.indexOf(id), 1); fail(id, 'The saved task plan is invalid; inspect its retained data before resuming.'); continue }
    if (!dependencyState(task, all, byId).ready) continue
    if (removingBots.has(task.botId) || removingBots.has(task.requesterBotId ?? task.botId)) continue
    if (runningSessions.has(task.sessionId) || isRunning(task.sessionId)) continue
    const workspaceKey = taskWorkspaceKey(task, all, getSession(task.sessionId)?.cwd)
    if (runningWorkspaces.has(workspaceKey)) continue
    waiting.splice(waiting.indexOf(id), 1)
    runningSessions.add(task.sessionId)
    runningWorkspaces.add(workspaceKey)
    lastStartedByBot.set(task.requesterBotId ?? task.botId, Date.now())
    running += 1
    void run(task)
      /*
       * `run` handles its own failures; this is the last resort. Without it a
       * throw from anywhere in there is an unhandled rejection that also leaves
       * the task pinned at 'running' forever, and — worse — never frees the
       * slot, so the pool drains to a standstill.
       */
      .catch((error: unknown) => fail(task.id, error instanceof Error ? error.message : String(error)))
      .finally(() => {
        running -= 1
        runningSessions.delete(task.sessionId)
        runningWorkspaces.delete(workspaceKey)
        pump()
      })
  }
  if (waiting.length > 0 && !retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = undefined; pump() }, 1000)
    retryTimer.unref?.()
  }
}

async function run(task: AgentTask): Promise<void> {
  try {
    assertBotAdmission(task.botId, task.requesterBotId ?? task.botId)
    // The run posts into the bot's home chat. Starting it on top of a turn
    // that is already going would be rejected and reported as a missing reply.
    if (isRunning(task.sessionId)) {
      return fail(task.id, 'This bot is already in the middle of a turn. Try again when the chat is idle.')
    }
    announce(setTaskStatus(task.id, 'running'))
    const session = getSession(task.sessionId)
    if (!session || !session.botIds.includes(task.botId)) throw new Error('The task execution conversation is unavailable.')
    const workspace = await prepareTaskWorkspace(task, listTasks(), session.cwd, () => getTask(task.id)?.status === 'running')
    await withTaskDecision(`task:${task.id}`, async () => {
      if (getTask(task.id)?.status !== 'running') throw new Error('The task was stopped during workspace preparation.')
      const current = getSession(task.sessionId)
      if (!current || !current.botIds.includes(task.botId)) throw new Error('The execution conversation changed during preparation.')
      if (current.cwd !== workspace.path) { forgetBindingsForSession(current.id); if (!setSessionCwd(current.id, workspace.path)) throw new Error('The assigned workspace could not be saved.') }
      task = await saveTaskRuntimeDurable(task.id, { workspace })
      await durable()
    })
    if (task.sourceSessionId) {
      // Never start an external executor before both task and private thread are durable.
      const persisted = await flushAll()
      if (persisted.failed.length || persisted.stillWriting) throw new Error('Could not persist the background task safely.')
      if (task.executionAgent) setExecutionAgent(task.sessionId, task.executionAgent, task.botId)
      else if (task.requesterBotId) setTeammateRun(task.sessionId, task.botId)
    }
    const send = await loopFn('sendMessage')
    if (!send) return fail(task.id, 'The agent runtime is unavailable.')
    if (getTask(task.id)?.status === 'cancelled') return
    /*
     * Where this run's messages begin.
     *
     * A failed turn persists `message.error`, which is what the check below
     * reads, but the agent loop also has paths that only emit an `error` event
     * and persist nothing — its catch-all around `iterate`, and the two early
     * returns before it. Those reported a cheerful "completed" for a task where
     * nothing ran at all, so a run that added no assistant message counts as a
     * failure too.
     */
    const before = getSession(task.sessionId)?.messages.length ?? 0
    let reportedError: string | undefined
    let reportedOutcome: 'completed' | 'cancelled' | 'failed' | undefined
    const stopListening = onAgentEvent((event) => {
      if (event.type === 'error' && event.sessionId === task.sessionId) reportedError = event.message
      if (event.type === 'done' && event.sessionId === task.sessionId && event.outcome) reportedOutcome = event.outcome
    })
    let nextPrompt = workspaceInstructions(workspace) + '\n\n' + task.prompt
    try {
      for (;;) {
        const batch = await withTaskDecision(`task:${task.id}`, async () => {
          const pending = (await taskMessages(task.id)).filter(value => value.status === 'queued')
          const unavailable = pending.filter(value => !messageBodies.has(`${task.id}:${value.requestId}`))
          if (unavailable.length) await setTaskMessageStatus(task.id, unavailable.map(value => value.requestId), 'uncertain')
          const ready = pending.filter(value => messageBodies.has(`${task.id}:${value.requestId}`))
          if (ready.length) await setTaskMessageStatus(task.id, ready.map(value => value.requestId), 'delivering', 'turn_boundary')
          return ready
        })
        if (getTask(task.id)?.status === 'cancelled') return
        const turnStart = getSession(task.sessionId)?.messages.length ?? 0
        reportedOutcome = undefined
        try { await send(task.sessionId, [nextPrompt, ...batch.map(value => `Additional instruction (${value.requestId}):\n${messageBodies.get(`${task.id}:${value.requestId}`)!}`)].filter(Boolean).join('\n\n')) }
        catch (error) {
          if (batch.length) await withTaskDecision(`task:${task.id}`, () => setTaskMessageStatus(task.id, batch.map(value => value.requestId), 'uncertain'))
          throw error
        }
        const turnMessages = getSession(task.sessionId)?.messages.slice(turnStart) ?? []
        const outcome = reportedOutcome
        const turnError = reportedError ?? turnMessages.find(value => value.error)?.error ?? (outcome === 'failed' ? 'The executor reported failure before completion.' : undefined)
        const replies = turnMessages.filter(value => value.role === 'assistant' && !value.uiOnly && !value.internal)
        const usableReply = replies.some(value => value.content.trim())
        if (batch.length) await withTaskDecision(`task:${task.id}`, () => setTaskMessageStatus(task.id, batch.map(value => value.requestId), outcome === 'cancelled' || turnError || !usableReply ? 'uncertain' : 'delivered', 'turn_boundary'))
        for (const message of batch) messageBodies.delete(`${task.id}:${message.requestId}`)
        if (getTask(task.id)?.status === 'cancelled') return
        if (outcome === 'cancelled') {
          await withTaskDecision(`task:${task.id}`, async () => {
            const current = getTask(task.id)
            if (!current || current.status === 'cancelled') return
            // Partial commentary survives in the transcript. Cancellation must
            // never turn it into a returned result or a restartable inbox item.
            settle(current.sourceSessionId ? cancelAgentTask(current.id) : setTaskStatus(current.id, 'cancelled'))
            const pending = (await taskMessages(current.id)).filter(value => value.status === 'queued')
            if (pending.length) await setTaskMessageStatus(current.id, pending.map(value => value.requestId), 'cancelled')
            await durable()
          })
          return
        }
        if (turnError) return fail(task.id, turnError)
        if (!replies.length) return fail(task.id, 'The run ended before the bot replied. Open its chat to see what happened.')
        if (!usableReply) return fail(task.id, 'The run ended without a usable result. Inspect its work before retrying.')
        const finished = await withTaskDecision(`task:${task.id}`, async () => {
          // Serialize completion with message admission: an accepted instruction
          // cannot fall between the final pending check and the terminal state.
          if ((await taskMessages(task.id)).some(value => value.status === 'queued')) return false
          if (getTask(task.id)?.status === 'cancelled') return true
          const produced = getSession(task.sessionId)?.messages.slice(before) ?? []
          const body = produced.filter(value => value.role === 'assistant' && !value.uiOnly && !value.internal).map(value => value.content).filter(Boolean).join('\n\n')
          const result = (body.slice(-27000) + `\n\nRetained task workspace: ${workspace.path}${workspace.branch ? '\nBranch: ' + workspace.branch : ''}. Outputs were not automatically merged or copied to the source directory.`).slice(-30000)
          const completed = settle(task.sourceSessionId ? completeAgentTask(task.id, result) : setTaskStatus(task.id, 'completed'))
          if (completed?.sourceSessionId) { await durable(); void drainTaskInbox(completed.sourceSessionId) }
          if (completed && !completed.sourceSessionId) postActivity('info', completed.title, 'Background execution ended. Inspect its session and result to assess whether the objective was met.', completed.sessionId, completed.botId)
          return true
        })
        if (finished) return
        nextPrompt = ''
      }
    } finally { stopListening() }
  } catch (error) {
    if (getTask(task.id)?.status !== 'cancelled') fail(task.id, error instanceof Error ? error.message : String(error))
  } finally {
    for (const key of messageBodies.keys()) if (key.startsWith(`${task.id}:`)) messageBodies.delete(key)
    if (task.executionAgent) clearExecutionAgent(task.sessionId)
    if (task.requesterBotId) clearTeammateRun(task.sessionId)
  }
}

async function reportToSource(task: AgentTask, text: string, uncertain = false, suffix?: string): Promise<void> {
  if (!task.sourceSessionId) return
  const source = await sessions.get(task.sourceSessionId)
  if (!source) return
  const id = `agent-result-${uncertain ? 'uncertain' : 'notice'}-${task.id}${suffix ? `-${suffix}` : ''}`
  if (!source.messages.some((message) => message.id === id)) await addNotice(source, getBot(task.requesterBotId ?? task.botId), text, undefined, id)
  await durable()
  if (!(await sessions.get(task.sourceSessionId))?.messages.some((message) => message.id === id)) throw new Error('The result notice was not saved.')
}

function fail(id: string, error: string): void {
  const before = getTask(id)
  if (!before || before.status === 'cancelled') return
  const task = settle(before?.sourceSessionId ? completeAgentTask(id, error, true) : setTaskStatus(id, 'failed', error))
  if (!task) return
  if (task.sourceSessionId) void durable().then(() => drainTaskInbox(task.sourceSessionId!)).catch(console.error)
  /*
   * The task pipeline owns the inbox entry for its own runs: `ipc/broadcast`
   * skips `error` events from a session a task is running, because it used to
   * post a second, differently worded item for the same failure. The desktop
   * notification that event would have raised is raised from here instead.
   */
  postActivity('failed', task.title, error, task.sourceSessionId ?? task.sessionId, task.botId, true)
}
