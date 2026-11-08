/** Update semantic information under the caller's task lock, without executing. */
import type { AgentTask } from '../../shared/types'
import { summariseTask } from '../../shared/activity'
import { getSession } from '../store/sessions'
import { saveTaskRuntimeDurable } from '../store/tasks'
import { parseTaskPlan } from './planning'
import { contextForTask, parseTaskContext, validateTaskParent } from './context'

export async function describeTask(task: AgentTask, context: unknown, tasks: AgentTask[], signal?: AbortSignal): Promise<AgentTask> {
  if (!task.sourceSessionId) throw new TypeError('Inspect the ownership of this legacy task before describing it.')
  if (task.planInvalid) throw new TypeError('The saved task plan is invalid; inspect it before changing its context.')
  if (context === undefined) throw new TypeError('Provide the complete updated task context.')
  const cwd = task.plan?.sourceCwd ?? getSession(task.sessionId)?.cwd
  if (!cwd) throw new TypeError('The source directory is unavailable.')
  // A legacy description update must retain the existing files and scheduling.
  const base = task.plan ? task : { ...task, plan: parseTaskPlan({ workspace: 'shared', workspace_reason: 'Keep the legacy task directory while updating its description.' }, cwd, task.sourceSessionId, task.requesterBotId ?? task.botId, tasks) }
  const nextContext = parseTaskContext(context)
  validateTaskParent(nextContext, tasks, task.sourceSessionId, task.requesterBotId ?? task.botId, task)
  const plan = { ...base.plan!, context: nextContext }
  if (signal?.aborted) throw new Error('The task description update was stopped.')
  return saveTaskRuntimeDurable(task.id, { plan })
}

export function describedTaskResult(task: AgentTask): Record<string, unknown> {
  return { task: { ...summariseTask(task), ...contextForTask(task) }, note: 'Description saved. Execution, authorization, dependencies and workspace did not change. A description update does not deliver new instructions to the executor; use message for active work or continue a returned task when actual work changes.' }
}
