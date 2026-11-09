import { useId, useRef, useState, useMemo, type ReactNode } from 'react'
import type { AgentTaskSummary } from '../../../shared/types'
import { agentText, taskGroups, taskStatus } from './agentTaskPresentation'

export function AgentTaskList({ tasks, botId, zh, loading, error, onRetry, onOpen }: {
  tasks: AgentTaskSummary[]; botId: string; zh: boolean; loading: boolean; error: boolean
  onRetry: () => void; onOpen: (task: AgentTaskSummary) => void
}): ReactNode {
  const [tab, setTab] = useState<'active' | 'ended'>('active')
  const group = useMemo(() => taskGroups(tasks, botId), [tasks, botId]), id = useId()
  const [limits, setLimits] = useState({ active: 50, ended: 50 })
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const tabs = ['active', 'ended'] as const
  return <section className="ob-agent-task-list" aria-label={zh ? 'Agent 任务' : 'Agent tasks'}>
    <div role="tablist" aria-label={zh ? '任务状态' : 'Task status'} className="ob-agent-task-tabs">
      {tabs.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-selected={tab === value}
        aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1} ref={node => { refs.current[index] = node }}
        onClick={() => setTab(value)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null
          if (next === null) return
          event.preventDefault(); setTab(tabs[next]!); refs.current[next]?.focus()
        }}>{value === 'active' ? (zh ? '进行中' : 'In progress') : (zh ? '已结束' : 'Ended')} <span>{group[value].length}</span></button>)}
    </div>
    {error ? <p role="alert" className="ob-agent-list-error">{zh ? '无法刷新任务列表，当前记录可能不是最新状态。' : 'Could not refresh tasks. These records may be out of date.'} <button type="button" className="ob-btn ob-btn-sm" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></p> : null}
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
      {loading && !group[tab].length ? <p className="ob-hint" role="status">{zh ? '正在读取任务…' : 'Loading tasks…'}</p> : null}
      {!loading && !group[tab].length && !error ? <p className="ob-hint">{tab === 'active' ? (zh ? '暂无进行中的任务' : 'No tasks in progress') : (zh ? '暂无已结束的任务' : 'No ended tasks')}</p> : null}
      <ul className="ob-agent-task-rows">{group[tab].slice(0, limits[tab]).map(task => <li key={task.id}>
        <button type="button" className="ob-agent-task-open" data-agent-task-id={task.id} onClick={() => onOpen(task)}>
          <strong>{agentText(task.title)}</strong><span data-task-status={task.status}>{taskStatus(task, zh)}</span>
          {task.progress && task.status === 'running' && task.progress.detail ? <small data-task-progress>{agentText(task.progress.detail)}</small> : null}
          {task.progress?.blocker ? <small data-task-blocker>{agentText(task.progress.blocker)}</small> : null}
          {task.status === 'completed' && !task.hasReview ? <small>{zh ? '结果待核对' : 'Result awaiting review'}</small> : null}
        </button>
      </li>)}</ul>
      {group[tab].length > limits[tab] ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setLimits(value => ({ ...value, [tab]: value[tab] + 50 }))}>{zh ? '显示更多任务' : 'Show more tasks'}</button> : null}
    </div>
  </section>
}
