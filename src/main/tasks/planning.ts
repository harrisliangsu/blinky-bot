import { isAbsolute } from 'node:path'
import type { AgentTask } from '../../shared/types'
import type { TaskPlan, TaskPlanInput, TaskPriority } from '../../shared/taskPlan'
import { parseTaskContext, validateTaskParent } from './context'

const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent']
export function parseTaskPlan(input: unknown, sourceCwd: string, sourceSessionId: string, ownerBotId: string, tasks: AgentTask[], previous?: AgentTask): TaskPlan {
  if (!isAbsolute(sourceCwd)) throw new TypeError('A task needs an existing absolute source directory.')
  const value = input === undefined ? {} : input
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid task plan.')
  const request = value as TaskPlanInput
  if (Object.keys(value).some(key => !['priority', 'priority_reason', 'depends_on', 'workspace', 'workspace_reason', 'session_reason', 'context'].includes(key))) throw new TypeError('Unknown task plan fields.')
  const priority = request.priority ?? previous?.plan?.priority ?? 'normal'
  if (!priorities.includes(priority)) throw new TypeError('Invalid task priority.')
  const workspace = request.workspace ?? previous?.plan?.workspace ?? 'shared'
  if (!['auto', 'isolated', 'shared'].includes(workspace)) throw new TypeError('Invalid task workspace choice.')
  const reason = (text: unknown): string => {
    if (text === undefined) return ''
    if (typeof text !== 'string' || text.length > 2000) throw new TypeError('Provide a short decision reason.')
    return text.trim()
  }
  const workspaceReason = reason(request.workspace_reason) || previous?.plan?.workspaceReason || ''
  if ((workspace === 'auto' || workspace === 'isolated') && !workspaceReason) throw new TypeError('A separate workspace needs the Bot’s task-specific reason (the user asked for isolation, independent git work, or active writers conflict on the same files). Shared work in the lead conversation’s source directory is the default and needs no reason.')
  const dependencies = request.depends_on ?? previous?.plan?.dependencies ?? []
  if (!Array.isArray(dependencies) || dependencies.length > 20 || new Set(dependencies).size !== dependencies.length || dependencies.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new TypeError('Invalid task dependencies.')
  for (const id of dependencies) {
    const dependency = tasks.find(task => task.id === id)
    if (!dependency || dependency.sourceSessionId !== sourceSessionId || (dependency.requesterBotId ?? dependency.botId) !== ownerBotId) throw new TypeError('A dependency must belong to this Bot and source conversation.')
    if (previous && (dependency.id === previous.id || dependency.sessionId === previous.sessionId) && ['queued', 'running'].includes(dependency.status)) throw new TypeError('A continuation cannot depend on its own active execution.')
  }
  const context = request.context === undefined ? previous?.plan?.context : parseTaskContext(request.context)
  validateTaskParent(context, tasks, sourceSessionId, ownerBotId, previous)
  return { priority, priorityReason: reason(request.priority_reason) || previous?.plan?.priorityReason || '', dependencies: [...dependencies], workspace, workspaceReason, sourceCwd, sessionReason: reason(request.session_reason) || (previous ? 'Continue the same delegated task with its existing context.' : 'Independent work receives its own execution conversation.'), ...(context ? { context } : {}) }
}

/** Malformed saved plans are refused; legacy tasks have no plan and stay legacy. */
export function parseSavedTaskPlan(input: unknown): TaskPlan | undefined {
  if (input === undefined) return undefined
  const value = input as TaskPlan
  if (!value || typeof value !== 'object' || !isAbsolute(value.sourceCwd ?? '') || !priorities.includes(value.priority) || !['auto', 'isolated', 'shared'].includes(value.workspace) || !Array.isArray(value.dependencies) || value.dependencies.length > 20 || new Set(value.dependencies).size !== value.dependencies.length || value.dependencies.some(id => typeof id !== 'string' || !id || id.length > 200) || ['priorityReason', 'workspaceReason', 'sessionReason'].some(key => typeof (value as unknown as Record<string, unknown>)[key] !== 'string')) throw new TypeError('The saved task plan is invalid; inspect it before resuming.')
  return { priority: value.priority, priorityReason: value.priorityReason.slice(0, 2000), dependencies: [...value.dependencies], workspace: value.workspace, workspaceReason: value.workspaceReason.slice(0, 2000), sourceCwd: value.sourceCwd, sessionReason: value.sessionReason.slice(0, 2000), ...(value.context === undefined ? {} : { context: parseTaskContext(value.context, true) }) }
}

export function dependencyState(task: AgentTask, tasks: AgentTask[], index: ReadonlyMap<string, AgentTask> = new Map(tasks.map(value => [value.id, value]))): { ready: boolean; waiting: string[]; failed: string[] } {
  const dependencies = (task.plan?.dependencies ?? []).map(id => ({ id, task: index.get(id) }))
  return { ready: dependencies.every(value => value.task?.status === 'completed'), waiting: dependencies.filter(value => value.task && ['queued', 'running'].includes(value.task.status)).map(value => value.id), failed: dependencies.filter(value => !value.task || ['failed', 'cancelled'].includes(value.task.status)).map(value => value.id) }
}

export function validateDependencyGraph(taskId: string, dependencies: string[], tasks: AgentTask[]): void {
  const byId = new Map(tasks.map(task => [task.id, task])), path = new Set<string>(), done = new Set<string>()
  const stack = dependencies.map(id => ({ id, exit: false }))
  while (stack.length) {
    const { id, exit } = stack.pop()!
    if (exit) { path.delete(id); done.add(id); continue }
    if (id === taskId || path.has(id)) throw new TypeError('The task dependencies would contain a cycle.')
    if (done.has(id)) continue
    const task = byId.get(id)
    if (!task) throw new TypeError('A task dependency is unavailable.')
    path.add(id); stack.push({ id, exit: true }); for (const next of task.plan?.dependencies ?? []) stack.push({ id: next, exit: false })
  }
}

/** Model-assigned importance, bounded by non-preemption and unbounded aging. */
export function rankQueuedTasks(tasks: AgentTask[], now: number, lastStarted: ReadonlyMap<string, number> = new Map()): AgentTask[] {
  const score = (task: AgentTask): number => priorities.indexOf(task.plan?.priority ?? 'normal') + Math.max(0, now - task.createdAt) / 120_000
  const owner = (task: AgentTask): string => task.requesterBotId ?? task.botId
  return tasks.filter(task => task.status === 'queued').sort((a, b) => score(b) - score(a) || (lastStarted.get(owner(a)) ?? 0) - (lastStarted.get(owner(b)) ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
