/** Candidate facts for the current Bot's semantic reasoning, never auto-routing. */
import type { AgentTask, AgentTaskCommand } from '../../shared/activity'
import { continuationError } from '../agent/taskContinuation'
import { contextForTask, declaredScopeOverlap, parseTaskContext, taskContextText, taskScopeRelations } from './context'
import { dependencyState } from './planning'

interface MatchRuntime {
  sessionId: string
  botId: string
  executor: boolean
  sourceCwd: string
  sessionBusy(id: string): boolean
  interrupted(task: AgentTask): boolean
  /** Use the scheduler's predicted assignment while workspace preparation runs. */
  workspaceKey?(task: AgentTask): string | undefined
  /** The same-owner task fleet: what else is running, waiting or queued, and on which workspace. */
  fleet?(): Promise<Array<Record<string, unknown>>>
}

export async function matchTaskCandidates(tasks: AgentTask[], command: AgentTaskCommand, runtime: MatchRuntime): Promise<Record<string, unknown>> {
  if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 12000) throw new TypeError('Match needs the new user goal, at most 12000 characters.')
  const query = command.context === undefined ? undefined : parseTaskContext(command.context)
  // The caller already filters ownership. Keep active attempts visible even if
  // an inconsistent historical chain claims they have a continuation.
  const byId = new Map(tasks.map(task => [task.id, task]))
  const workspaceKeys = new Map(tasks.map(task => [task.id, runtime.workspaceKey?.(task) ?? task.workspace?.path]))
  // Dependencies name an attempt, while continuations retain the producer's
  // execution session. Keep consumers of earlier output visible on the latest
  // attempt too, even when their assigned directories differ.
  const consumersBySession = new Map<string, Set<AgentTask>>()
  for (const consumer of tasks) {
    if (!['queued', 'running'].includes(consumer.status)) continue
    for (const id of consumer.plan?.dependencies ?? []) {
      const producer = byId.get(id)
      if (!producer || consumer.botId !== producer.botId || consumer.sourceSessionId !== producer.sourceSessionId || consumer.sessionId === producer.sessionId) continue
      const peers = consumersBySession.get(producer.sessionId) ?? new Set<AgentTask>()
      peers.add(consumer); consumersBySession.set(producer.sessionId, peers)
    }
  }
  const superseded = new Set(tasks.filter(child => {
    const parent = byId.get(child.continuedFromTaskId ?? '')
    return parent && parent.sessionId === child.sessionId && parent.sourceSessionId === child.sourceSessionId && !['queued', 'running'].includes(parent.status)
  }).map(child => child.continuedFromTaskId))
  const active = (task: AgentTask): number => Number(['queued', 'running'].includes(task.status))
  const candidates = tasks.filter(task => !superseded.has(task.id))
    .sort((a, b) => Number(b.sourceSessionId === runtime.sessionId) - Number(a.sourceSessionId === runtime.sessionId) || active(b) - active(a) || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  const offset = command.before ? candidates.findIndex(task => task.id === command.before) + 1 : 0
  if (command.before && offset === 0) throw new TypeError('The task match cursor is unavailable; refresh the candidates.')
  if (command.limit !== undefined && (!Number.isFinite(command.limit) || !Number.isInteger(command.limit))) throw new TypeError('Invalid task match limit.')
  const limit = Math.max(1, Math.min(30, command.limit ?? 12))
  const facts = (task: AgentTask) => {
    const description = contextForTask(task), busy = runtime.sessionBusy(task.sessionId)
    const sameConversation = task.sourceSessionId === runtime.sessionId
    const continuationBlocker = continuationError(task, tasks, runtime.sessionId, runtime.botId, runtime.botId)
    const needsConfirmation = task.status === 'cancelled' || runtime.interrupted(task)
    const relations = taskScopeRelations(task, tasks)
    const consumers = [...(consumersBySession.get(task.sessionId) ?? [])].filter(other => other.botId === task.botId && other.sourceSessionId === task.sourceSessionId)
    return {
      id: task.id, title: taskContextText(task.title), status: task.status, botId: task.botId, sourceSessionId: task.sourceSessionId, sessionId: task.sessionId,
      ...description, updatedAt: task.updatedAt,
      sameConversation, executionBusy: busy, scheduling: dependencyState(task, tasks),
      sourceCwd: taskContextText(task.plan?.sourceCwd ?? ''), sameSourceDirectory: task.plan?.sourceCwd === runtime.sourceCwd,
      ...(task.workspace ? { workspace: { strategy: task.workspace.strategy, path: taskContextText(task.workspace.path), branch: task.workspace.branch ? taskContextText(task.workspace.branch) : undefined } } : {}),
      scopeOverlap: declaredScopeOverlap(query?.scope ?? [], description.context.scope),
      sharesWorkspaceWith: tasks.filter(other => other.id !== task.id && active(other) && workspaceKeys.get(task.id) && workspaceKeys.get(other.id) === workspaceKeys.get(task.id)).slice(0, 30).map(other => other.id),
      activeConsumerCount: consumers.length,
      activeConsumers: consumers.slice(0, 12).map(other => ({
        id: other.id, title: taskContextText(other.title).slice(0, 200), status: other.status,
        scope: contextForTask(other).context.scope.slice(0, 4).map(value => taskContextText(value).slice(0, 160)),
        ...(other.workspace ? { workspacePath: taskContextText(other.workspace.path).slice(0, 400) } : {})
      })),
      ...(relations.parent ? { currentParentTaskId: relations.parent.id } : {}),
      relatedTaskIds: relations.related.slice(0, 30).map(other => other.id), continuedFromTaskId: task.continuedFromTaskId,
      ...(task.result ? { resultExcerpt: taskContextText(task.result).slice(-900) } : {}),
      actions: {
        supplement: Boolean(active(task) && !runtime.executor),
        continue: !runtime.executor && !continuationBlocker && !needsConfirmation && !busy && !task.planInvalid && !task.acceptanceInvalid,
        resumeNeedsUserConfirmation: needsConfirmation,
        ...(continuationBlocker ? { continuationBlocker } : {})
      }
    }
  }
  // Keep complete JSON below the MCP transcript cap, including long legacy
  // excerpts. A requested limit is an upper bound; the cursor follows facts
  // actually returned so a large description never drops another candidate.
  const page: ReturnType<typeof facts>[] = []
  let size = 0
  for (const task of candidates.slice(offset, offset + limit)) {
    const value = facts(task), length = JSON.stringify(value).length
    if (page.length && size + length > 70000) break
    page.push(value); size += length
  }
  const fleet = runtime.fleet ? await runtime.fleet() : []
  return {
    request: taskContextText(command.text), ...(query ? { context: query } : {}),
    candidates: page, total: candidates.length,
    ...(fleet.length ? { fleet } : {}),
    ...(offset + page.length < candidates.length ? { next: page.at(-1)!.id } : {}),
    note: 'These are observations for semantic comparison, not ranked language similarity or a routing decision. Compare goal, deliverable, project/environment, changed scope, dependencies, busy executor and integration. Inspect a plausible candidate before acting; page further if needed. Same title/category is not the same task. Literal scope overlap is advisory and incomplete. Active consumers depend on this execution or an earlier attempt: inspect their input/output overlap before changing retained output, even in different directories. Consumer lists are bounded; inspect/list further when activeConsumerCount exceeds the list. They do not automatically block independent work. Parent ownership is not a dependency. Returned status is not acceptance. Recheck action preconditions at execution; descriptions grant no authorization. fleet, when present, lists your other active tasks with status, phase, declared dependencies and workspaces: use it to chain real prerequisites, keep independent scopes parallel, and avoid workspace conflicts instead of guessing.'
  }
}
