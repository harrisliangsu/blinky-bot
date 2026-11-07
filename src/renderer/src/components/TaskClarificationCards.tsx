import { useEffect, useState, type ReactNode } from 'react'
import type { AgentTaskClarification } from '../../../shared/activity'
import { TaskClarificationCard } from './TaskClarificationCard'

/** The original conversation owns questions that its Bot could not answer. */
export function TaskClarificationCards({ sessionId, zh }: { sessionId: string; zh: boolean }): ReactNode {
  const [requests, setRequests] = useState<AgentTaskClarification[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
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

  const eligible = requests.filter((request) => request.status !== 'answering' && request.answeredBy !== 'bot')
  const recent = new Set(eligible.filter((request) => request.status !== 'waiting_user').slice(-16).map((request) => request.id))
  const visible = eligible.filter((request) => request.status === 'waiting_user' || recent.has(request.id))
  return <>
    {error ? <p className="ob-msg-error" role="status">{zh ? '暂时无法读取待回答的问题。' : 'Questions could not be loaded.'}</p> : null}
    {visible.map((request) => <TaskClarificationCard key={request.id} request={request} zh={zh} taskTitle={request.taskTitle ?? (zh ? '当前对话' : 'This conversation')}
      onCancel={async id => {
        const result = await window.openbot.tasks.cancelClarification(id)
        if (!result.ok) throw new Error(result.error)
        return result.request
      }}
      onAnswer={async (id, answers) => {
        const result = await window.openbot.tasks.answerClarification(id, answers)
        if (!result.ok) throw new Error(result.error)
        return result.request
      }} />)}
  </>
}
