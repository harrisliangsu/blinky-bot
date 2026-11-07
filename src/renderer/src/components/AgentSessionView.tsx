import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { AgentTask, AgentTaskSummary } from '../../../shared/types'
import { useAppState } from '../state'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentTranscript } from './AgentTranscript'
import { useBotChinese } from './BotUiLanguage'
import { IconClose } from './Icons'
import { agentText, isEndedTask, taskStatus } from './agentTaskPresentation'
import './AgentSessionView.css'

function TaskSummary({ task, zh }: { task: AgentTask; zh: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return <details className="ob-agent-task-summary" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{zh ? '任务与结果摘要' : 'Task and result summary'}</summary>
    {expanded ? <div><h3>{zh ? '任务要求' : 'Task request'}</h3><AgentMarkdown text={task.prompt} />
      {task.result ? <><h3>{zh ? '执行器返回' : 'Executor response'}</h3><AgentMarkdown text={task.result} /></> : null}
      {task.acceptance ? <><h3>{zh ? '要求核对的文件' : 'Files to verify'}</h3><ul>{task.acceptance.files.map(file => <li key={file.path}>{agentText(file.path)}</li>)}</ul></> : null}
      {task.acceptanceInvalid ? <p role="alert">{zh ? '保存的文件检查条件无效，不能据此确认完成。' : 'Saved file checks are invalid and cannot confirm completion.'}</p> : null}
      {task.review ? <><h3>{task.review.outcome === 'blocked' ? (zh ? 'Bot 报告受阻' : 'Bot reports a blocker') : (zh ? 'Bot 声称已完成' : 'Bot claims completion')}</h3><AgentMarkdown text={task.review.summary} />
        {task.review.evidence.length ? <ul>{task.review.evidence.map((entry, index) => <li key={index}>{agentText(entry)}</li>)}</ul> : null}
        {task.review.verifiedFiles?.length ? <><h3>{zh ? '应用核对的文件' : 'Files checked by the app'}</h3><ul>{task.review.verifiedFiles.map(file => <li key={file.path}>{agentText(file.path)}</li>)}</ul></> : null}
        <p className="ob-hint">{zh ? '这是 Bot 的判断；文件检查只证明所列条件，其他证据仍需核对。' : 'This is the Bot’s assessment. File checks cover only the listed conditions; other evidence still needs verification.'}</p>
      </> : task.status === 'completed' ? <p className="ob-hint">{zh ? '执行已结束，结果尚无完成核对记录。' : 'Execution has ended. No completion assessment is recorded.'}</p> : null}
    </div> : null}
  </details>
}

export function AgentSessionView({ task, onClose }: { task: AgentTaskSummary | null; onClose: () => void }): ReactNode {
  const zh = useBotChinese(), { modal, tasks } = useAppState()
  const [detail, setDetail] = useState<AgentTask | null>(null)
  const [detailError, setDetailError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setDetailError(false)
    if (!task) { setDetail(null); return }
    void window.openbot.tasks.get(task.id).then(value => {
      if (!active) return
      if (!value || value.id !== task.id || value.sessionId !== task.sessionId || value.botId !== task.botId) { setDetail(null); setDetailError(true); return }
      setDetail(value)
    }).catch(() => { if (active) setDetailError(true) })
    return () => { active = false }
  }, [task?.id, task?.sessionId, task?.botId, task?.updatedAt, retry])
  // Continuations intentionally reuse the private session. Keep the selected
  // task's terminal outcome, while still following that conversation's work.
  const continuing = task ? tasks.filter(value => value.id !== task.id && value.sessionId === task.sessionId && value.botId === task.botId && !isEndedTask(value.status)) : []
  const running = task?.status === 'running' || continuing.some(value => value.status === 'running')
  const close = useRef<HTMLButtonElement>(null), title = useId()
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Higher dialogs own Escape first. Repeated Escape must not close the
      // parent details or reach the main chat's stop shortcut.
      if (event.key !== 'Escape' || modal) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (!event.repeat && !event.isComposing) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose, modal])
  return <section className="ob-agent-session-view" aria-labelledby={title}>
    <header className="ob-agent-session-head">
      <button ref={close} type="button" className="ob-btn ob-no-drag ob-agent-return" onClick={onClose} aria-label={zh ? '关闭 Agent 会话，返回主聊天' : 'Close Agent session and return to main chat'}><IconClose size={14} />{zh ? '返回主聊天' : 'Back to chat'}</button>
      <div><h2 id={title}>{task ? agentText(task.title) : (zh ? '执行会话不可用' : 'Execution session unavailable')}</h2>
        <span className="ob-hint" data-agent-session-status={task?.status}>{task ? taskStatus(task, zh) : (zh ? '任务归属或会话已改变' : 'Task ownership or session has changed')}{task?.executionAgent ? ` · ${agentText(task.executionAgent.modelId || task.executionAgent.backendId)}` : ''}</span>
      </div>
    </header>
    {task ? <>
      <div className="ob-agent-session-meta">
        {continuing.length ? <p className="ob-hint">{zh ? '同一执行会话仍有未结束的任务，下面会继续更新会话记录。' : 'This execution conversation has other unfinished tasks. Its records will continue updating below.'}</p> : null}
        {task.error ? <p className="ob-msg-error" role="alert">{agentText(task.error)}</p> : null}
        {task.status === 'cancelled' ? <p className="ob-hint">{zh ? '任务已取消；保留中断前收到的记录。' : 'Task cancelled. Records received before interruption are retained.'}</p> : null}
        {detailError ? <p role="alert">{zh ? '无法刷新任务摘要。' : 'Could not refresh task details.'} <button className="ob-btn ob-btn-sm" onClick={() => setRetry(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></p> : null}
        {detail ? <TaskSummary task={detail} zh={zh} /> : null}
      </div>
      <AgentTranscript sessionId={task.sessionId} botId={task.botId} zh={zh} running={running} watching={!isEndedTask(task.status) || continuing.length > 0} backendId={task.executionAgent?.backendId} />
    </> : <p className="ob-agent-empty" role="alert">{zh ? '无法在当前 Bot 中展示此执行会话。请返回主聊天。' : 'This execution session cannot be shown for the current Bot. Return to the main chat.'}</p>}
  </section>
}
