/** Background-task orchestration shared by the renderer and delegate_task. */

import type { AgentTask } from '../shared/types'
import { isRunning } from './agent/cancel'
import { loopFn } from './ipc/agentRuntime'
import { broadcast, postActivity } from './ipc/broadcast'
import { getBot } from './store/bots'
import { ensureBotHome } from './store/botHome'
import { getSession } from './store/sessions'
import { countActiveTasks, createTaskRecord, getTask, setTaskStatus, trimTasks } from './store/tasks'

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
const MAX_CONCURRENT_RUNS = 2

/**
 * Ceilings on queued + running work, overall and for one bot.
 *
 * The pool bounds how much runs at once but not how much is waiting: a runaway
 * delegating model would still enqueue thousands of runs, each one a session
 * file and a slot in memory. Creation is refused past these instead, with a
 * message the caller shows the user.
 */
const MAX_ACTIVE_TASKS = 32
const MAX_ACTIVE_TASKS_PER_BOT = 4

/** Ids of queued tasks waiting for a slot, oldest first. */
const waiting: string[] = []
let running = 0

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

export function startBackgroundTask(botId: string, prompt: string, title = prompt.slice(0, 80)): AgentTask {
  const bot = getBot(botId)
  if (!bot) throw new TypeError('That bot no longer exists.')
  const body = prompt.trim().slice(0, 100_000)
  if (!body) throw new TypeError('A background task needs a prompt.')
  if (countActiveTasks() >= MAX_ACTIVE_TASKS) {
    throw new TypeError(`Too much background work is already queued (${MAX_ACTIVE_TASKS} tasks). Wait for some to finish, or cancel a few.`)
  }
  if (countActiveTasks(botId) >= MAX_ACTIVE_TASKS_PER_BOT) {
    throw new TypeError(`${bot.name} already has ${MAX_ACTIVE_TASKS_PER_BOT} background tasks queued or running.`)
  }
  const label = title.trim().slice(0, 200) || 'Background task'
  // The result belongs in the bot's one chat. A side session would show up as
  // a second conversation and the next launch would archive it.
  const session = ensureBotHome(botId)
  if (!session) throw new TypeError('That bot no longer exists.')
  const task = createTaskRecord(botId, session.id, body, label)
  broadcast({ type: 'session-updated', session })
  announce(task)
  waiting.push(task.id)
  pump()
  return task
}

/** A bot may delegate only to a teammate the user put in this conversation. */
export function delegateBackgroundTask(
  sourceSessionId: string,
  fromBotId: string,
  toBotId: string,
  prompt: string,
  title?: string
): AgentTask {
  const source = getSession(sourceSessionId)
  if (!source) throw new TypeError('The source conversation no longer exists.')
  if (fromBotId === toBotId) throw new TypeError('A bot cannot delegate a task to itself.')
  if (!source.botIds.includes(fromBotId) || !source.botIds.includes(toBotId)) {
    throw new TypeError('Delegation is limited to bots already in this conversation.')
  }
  return startBackgroundTask(toBotId, prompt, title)
}

export async function cancelBackgroundTask(id: string): Promise<AgentTask | null> {
  const task = getTask(id)
  if (!task || !['queued', 'running'].includes(task.status)) return task
  /*
   * A queued task holds no session run yet, so dropping it from the queue is
   * the whole job — and `pump` re-reads the record before starting anything,
   * which is what makes "cancel" mean "never starts" rather than "starts and
   * is stopped a moment later".
   */
  const position = waiting.indexOf(task.id)
  if (position >= 0) waiting.splice(position, 1)
  if (task.status === 'running') {
    const stop = await loopFn('stopSession')
    if (stop) await stop(task.sessionId)
  }
  return settle(setTaskStatus(task.id, 'cancelled'))
}

/** Start queued tasks while the pool has room. Safe to call at any time. */
function pump(): void {
  while (running < MAX_CONCURRENT_RUNS) {
    const id = waiting.shift()
    if (id === undefined) return
    const task = getTask(id)
    // Cancelled — or trimmed away — while it waited. The freed slot goes to the
    // next task instead of being spent on a run nobody is waiting for.
    if (!task || task.status !== 'queued') continue
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
        pump()
      })
  }
}

async function run(task: AgentTask): Promise<void> {
  try {
    // The run posts into the bot's home chat. Starting it on top of a turn
    // that is already going would be rejected and reported as a missing reply.
    if (isRunning(task.sessionId)) {
      return fail(task.id, 'This bot is already in the middle of a turn. Try again when the chat is idle.')
    }
    announce(setTaskStatus(task.id, 'running'))
    const send = await loopFn('sendMessage')
    if (!send) return fail(task.id, 'The agent runtime is unavailable.')
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
    await send(task.sessionId, task.prompt)
    const current = getTask(task.id)
    if (current?.status === 'cancelled') return
    const produced = getSession(task.sessionId)?.messages.slice(before) ?? []
    const failed = produced.find((message) => Boolean(message.error))
    if (failed?.error) return fail(task.id, failed.error)
    if (!produced.some((message) => message.role === 'assistant')) {
      return fail(task.id, 'The run ended before the bot replied. Open its chat to see what happened.')
    }
    const completed = settle(setTaskStatus(task.id, 'completed'))
    if (completed) {
      postActivity('completed', completed.title, 'Background agent task completed.', completed.sessionId, completed.botId)
    }
  } catch (error) {
    fail(task.id, error instanceof Error ? error.message : String(error))
  }
}

function fail(id: string, error: string): void {
  const task = settle(setTaskStatus(id, 'failed', error))
  if (!task) return
  /*
   * The task pipeline owns the inbox entry for its own runs: `ipc/broadcast`
   * skips `error` events from a session a task is running, because it used to
   * post a second, differently worded item for the same failure. The desktop
   * notification that event would have raised is raised from here instead.
   */
  postActivity('failed', task.title, error, task.sessionId, task.botId, true)
}
