import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentTaskSummary } from '../../../shared/types'
import { loadRoutines, runRoutine, useAppState } from '../state'
import { AgentTaskList } from './AgentTaskList'
import { useAgentSessionWorkspace } from './AgentSessionWorkspace'
import { BotEditor } from './BotEditor'
import { useBotChinese } from './BotUiLanguage'
import { IconClose } from './Icons'
import { useReturnFocus } from './returnFocus'
import './BotDetailsPanel.css'

/** The active bot's configuration and work share the space beside its chat. */
export function BotDetailsPanel({ onClose }: { onClose: () => void }): ReactNode {
  useReturnFocus()
  const closeButton = useRef<HTMLButtonElement>(null)
  const closeEditor = useRef<(() => void) | null>(null)
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }) }, [])
  const { session, bots, settings, backends, backendsLoading, backendsError, tasks, routines, routinesError } = useAppState()
  const zh = useBotChinese()
  const { open } = useAgentSessionWorkspace()
  const [loadedTasks, setLoadedTasks] = useState<AgentTaskSummary[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksError, setTasksError] = useState(false)
  const [retry, setRetry] = useState(0)
  const bot = bots.find((item) => item.id === session?.activeBotId)
  useEffect(() => { void loadRoutines() }, [])
  useEffect(() => {
    let active = true
    setTasksLoading(true); setTasksError(false)
    setLoadedTasks([])
    void window.openbot.tasks.summaries(bot?.id).then(value => { if (active) setLoadedTasks(value) })
      .catch(() => { if (active) setTasksError(true) })
      .finally(() => { if (active) setTasksLoading(false) })
    return () => { active = false }
  }, [bot?.id, retry])
  if (!bot || !settings) return null
  const merged = new Map(loadedTasks.map(task => [task.id, task]))
  for (const task of tasks) if (!merged.has(task.id) || task.updatedAt >= merged.get(task.id)!.updatedAt) merged.set(task.id, task)
  const scheduled = routines.filter((routine) => routine.botId === bot.id && routine.trigger.kind !== 'manual')
  return <aside id="ob-bot-details" className="ob-bot-details" aria-label={zh ? `${bot.name} 详情` : `${bot.name} details`}>
    <header className="ob-bot-details-head"><span>{zh ? 'Bot 详情' : 'Bot details'}</span><button ref={closeButton} type="button" className="ob-icon-btn ob-no-drag" onClick={() => closeEditor.current?.()} aria-label={zh ? '关闭 Bot 详情' : 'Close bot details'}><IconClose /></button></header>
    <div className="ob-bot-details-body">
      <section className="ob-bot-details-section"><h3>{zh ? 'Agent 任务' : 'Agent tasks'}</h3>
        <AgentTaskList key={bot.id} tasks={[...merged.values()]} botId={bot.id} zh={zh} loading={tasksLoading} error={tasksError} onRetry={() => setRetry(value => value + 1)} onOpen={open} />
      </section>
      <section className="ob-bot-details-section"><h3>{zh ? '定时任务' : 'Scheduled routines'}</h3>
        {routinesError ? <p role="alert">{routinesError}</p> : scheduled.length ? <div className="ob-bot-details-list">{scheduled.map((routine) => <div className="ob-bot-details-routine" key={routine.id}><span><strong>{routine.name}</strong><small>{routine.trigger.kind === 'github_issue' ? `GitHub ${routine.trigger.owner}/${routine.trigger.repo} #${routine.trigger.issueNumber}` : routine.trigger.kind === 'gmail_query' ? `Gmail · ${routine.trigger.query ?? ''}` : routine.trigger.kind === 'webhook' ? 'Webhook' : routine.trigger.cron}{routine.watchError ? ` · ${routine.watchError}` : ''}</small></span><button type="button" className="ob-btn ob-btn-sm" onClick={() => void runRoutine(routine.id)}>{zh ? '运行' : 'Run'}</button></div>)}</div> : <p className="ob-hint">{zh ? '暂无定时任务' : 'No scheduled routines'}</p>}
      </section>
      <section className="ob-bot-details-section"><h3>{zh ? 'Bot 配置' : 'Bot configuration'}</h3>
        <BotEditor key={bot.id} bot={bot} backends={backends} backendsLoading={backendsLoading} backendsError={backendsError} onClose={onClose} onSaved={() => {}} escapeCloseRef={closeEditor} embedded />
      </section>
    </div>
  </aside>
}
