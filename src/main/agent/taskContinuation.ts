import type { AgentTask } from '../../shared/types'

/** Validate a continuation before accepting or starting another execution. */
export function continuationError(
  previous: AgentTask | null,
  tasks: AgentTask[],
  sourceSessionId: string,
  fromBotId: string,
  toBotId: string,
  explicitlyResumeCancelled = false
): string | null {
  if (!previous || previous.sourceSessionId !== sourceSessionId || (previous.requesterBotId ?? previous.botId) !== fromBotId || (toBotId !== fromBotId && toBotId !== previous.botId) || (!previous.executionAgent && !previous.requesterBotId)) {
    return 'That independent task does not belong to this conversation and bot.'
  }
  if (!['completed', 'failed'].includes(previous.status) && !(explicitlyResumeCancelled && previous.status === 'cancelled')) return 'Only a returned or failed task can be continued; a cancelled task needs an explicit resume command.'
  if (tasks.some((task) => task.continuedFromTaskId === previous.id)) return 'This task result already has a continuation.'
  return null
}

/** Preserve the original objective when a later continuation returns. */
export function taskReviewObjective(task: AgentTask, tasks: AgentTask[]): string {
  const byId = new Map(tasks.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const continuations: string[] = []
  let current = task
  while (current.continuedFromTaskId) {
    if (seen.has(current.id)) throw new Error('The task continuation chain contains a cycle; the original objective cannot be confirmed.')
    seen.add(current.id)
    continuations.push(current.prompt)
    const previous = byId.get(current.continuedFromTaskId)
    if (!previous || previous.sourceSessionId !== task.sourceSessionId || previous.sessionId !== task.sessionId || previous.botId !== task.botId || (previous.requesterBotId ?? previous.botId) !== (task.requesterBotId ?? task.botId)) {
      throw new Error('The task continuation chain is incomplete or inconsistent; the original objective cannot be confirmed.')
    }
    current = previous
  }
  if (seen.has(current.id)) throw new Error('The task continuation chain contains a cycle; the original objective cannot be confirmed.')
  if (!current.prompt.trim()) throw new Error('The original task objective is unavailable; completion cannot be confirmed.')
  return continuations.length ? `Original delegated objective:\n${current.prompt}\n\nContinuation instructions in order:\n${continuations.reverse().map((prompt, index) => `${index + 1}. ${prompt}`).join('\n\n')}` : current.prompt
}
