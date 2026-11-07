import type { AgentTask } from '../../shared/types'

/** A room grant never becomes workspace authority through task identifiers. */
export function taskVisibleInRoom(task: Pick<AgentTask, 'sessionId' | 'sourceSessionId'> | null, sessionId: string): boolean {
  return !!task && (task.sessionId === sessionId || task.sourceSessionId === sessionId)
}
