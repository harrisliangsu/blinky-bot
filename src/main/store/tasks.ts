import { randomUUID } from 'node:crypto'
import type { AgentTask, AgentTaskStatus, Session } from '../../shared/types'
import { JsonCollection } from './collection'
import { tasksDir } from './paths'
import { archiveSession, getSession } from './sessions'

const collection = new JsonCollection<AgentTask>(tasksDir, normalise)
const statuses: AgentTaskStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']
/** Waiting or working: the two statuses that describe live, uncompleted work. */
const active: AgentTaskStatus[] = ['queued', 'running']

/**
 * Finished tasks kept, newest first — the same bound `store/activity.ts` puts
 * on the inbox, for the same reason. Nothing ever trimmed this collection, so a
 * daily ten-bot broadcast left thousands of task documents behind, every one of
 * them read into memory at boot and walked by search.
 */
const MAX_FINISHED_TASKS = 200

function normalise(raw: unknown): AgentTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value['id'] !== 'string' || typeof value['botId'] !== 'string' || typeof value['sessionId'] !== 'string') return null
  const status = statuses.includes(value['status'] as AgentTaskStatus) ? value['status'] as AgentTaskStatus : 'failed'
  return {
    id: value['id'], botId: value['botId'], sessionId: value['sessionId'], status,
    title: typeof value['title'] === 'string' ? value['title'].slice(0, 200) : 'Background task',
    prompt: typeof value['prompt'] === 'string' ? value['prompt'].slice(0, 100_000) : '',
    createdAt: Number(value['createdAt']) || Date.now(), updatedAt: Number(value['updatedAt']) || Date.now(),
    ...(typeof value['error'] === 'string' ? { error: value['error'].slice(0, 2000) } : {})
  }
}

export async function loadTasks(): Promise<void> {
  await collection.load()
  // An active task cannot survive the main process that owned its model stream.
  // Make that explicit instead of leaving a permanent "running" spinner after
  // a crash or forced quit.
  for (const task of collection.all()) {
    if (task.status === 'queued' || task.status === 'running') {
      setTaskStatus(task.id, 'failed', 'BlinkyBot closed before this task finished. Open its chat to retry safely.')
    }
  }
}
export const listTasks = (): AgentTask[] => collection.all().sort((a, b) => b.updatedAt - a.updatedAt)
export const getTask = (id: string): AgentTask | null => collection.get(id)

/** Queued + running, for every bot or just one. The worker pool's admission check. */
export function countActiveTasks(botId?: string): number {
  return collection.all().filter((task) => active.includes(task.status) && (botId === undefined || task.botId === botId)).length
}

/**
 * True while a queued or running background task owns this session.
 *
 * The task pipeline posts its own inbox item when a run settles, so
 * `ipc/broadcast` uses this to skip the duplicate it used to post for the same
 * failure. A finished task deliberately does not count: once the pipeline has
 * settled, nothing else would report a later failure in that chat.
 */
export const hasActiveTask = (sessionId: string): boolean =>
  collection.all().some((task) => task.sessionId === sessionId && active.includes(task.status))

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
    .filter((task) => !active.includes(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const archived: Session[] = []
  for (const task of finished.slice(MAX_FINISHED_TASKS)) {
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
    const next = archiveSession(task.sessionId)
    if (next) archived.push(next)
  }
  return archived
}

export function createTaskRecord(botId: string, sessionId: string, prompt: string, title: string): AgentTask {
  const now = Date.now()
  return collection.put({ id: randomUUID(), botId, sessionId, prompt: prompt.slice(0, 100_000), title: title.slice(0, 200) || 'Background task', status: 'queued', createdAt: now, updatedAt: now })
}

export function setTaskStatus(id: string, status: AgentTaskStatus, error?: string): AgentTask | null {
  const task = collection.get(id)
  if (!task) return null
  const next: AgentTask = { ...task, status, updatedAt: Date.now() }
  if (error) next.error = error.slice(0, 2000)
  else delete next.error
  return collection.put(next)
}
