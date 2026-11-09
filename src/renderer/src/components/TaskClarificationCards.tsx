import { useEffect, useState, type ReactNode } from 'react'
import type { AgentTaskClarification } from '../../../shared/activity'
import { TaskClarificationCard } from './TaskClarificationCard'

/** The original conversation owns questions that its Bot could not answer. */
export function useTaskClarifications(sessionId: string | undefined): { requests: AgentTaskClarification[]; error: boolean } {
  const [requests, setRequests] = useState<AgentTaskClarification[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!sessionId) { setRequests([]); setError(false); return }
    let active = true
    const received = new Map<string, AgentTaskClarification>()
    const publish = (): void => {
      if (active) setRequests([...received.values()].sort((a, b) => a.createdAt - b.createdAt))
    }
    const accept = (request: AgentTaskClarification): void => {
      if (request.sourceSessionId !== sessionId) return
      const old = received.get(request.id)
      if (!old || old.updatedAt <= request.updatedAt) received.set(request.id, request)
    }
    setRequests([]); setError(false)
    const unsubscribe = window.openbot.on((event) => {
      if (event.type === 'task-clarification-updated') { accept(event.request); publish() }
    })
    void window.openbot.tasks.clarifications().then((items) => {
      if (!active) return
      for (const item of items) accept(item)
      publish()
    }).catch(() => { if (active) setError(true) })
    return () => { active = false; unsubscribe() }
  }, [sessionId])

  return { requests: requests.filter(request => request.sourceSessionId === sessionId), error }
}

export function TaskClarificationEntry({ request, zh }: { request: AgentTaskClarification; zh: boolean }): ReactNode {
  return <TaskClarificationCard request={request} zh={zh}
    onCancel={async id => {
      const result = await window.openbot.tasks.cancelClarification(id)
      if (!result.ok) throw new Error(result.error)
      return result.request
    }}
    onAnswer={async (id, answers) => {
      const result = await window.openbot.tasks.answerClarification(id, answers)
      if (!result.ok) throw new Error(result.error)
      return result.request
    }} />
}
