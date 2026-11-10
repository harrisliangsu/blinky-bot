import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Message } from '../../../shared/types'
import { showsJump, useStickyScroll } from '../lib/stickyScroll'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentThinking } from './AgentThinking'
import { agentMessageParts } from './agentTranscriptPresentation'
import { observeAgentSession, type AgentSessionSnapshot } from './agentSessionReader'
import { agentActivities, agentText, type AgentActivity } from './agentTaskPresentation'
import './Message.css'
import './Transcript.css'

const NO_STEPS: AgentActivity[] = []

const AgentMessage = memo(function AgentMessage({ message, steps, running, zh }: { message: Message; steps: AgentActivity[]; running: boolean; zh: boolean }): ReactNode {
  const { answer, reasoning, commentary } = agentMessageParts(message)
  if (!(answer || steps.length || reasoning || commentary || message.error || message.attachments?.length)) return null
  return <article className={`ob-msg ob-msg-${message.role === 'user' ? 'user' : 'assistant'}`}>
    <div className="ob-msg-shell">
      <div className="ob-msg-author"><span className="ob-msg-author-name">{message.role === 'user' ? (zh ? '用户' : 'User') : 'Agent'}</span>{message.model ? <span className="ob-msg-model">{agentText(message.model)}</span> : null}</div>
      <AgentThinking reasoning={reasoning} steps={steps} commentary={commentary} running={running} zh={zh} />
      {answer ? message.role === 'user' ? <div className="ob-msg-bubble">{agentText(answer)}</div> : <div className="ob-msg-answer"><AgentMarkdown text={answer} /></div> : null}
      {message.attachments?.length ? <ul className="ob-msg-attach-list">{message.attachments.map(attachment => <li key={attachment.id}>{agentText(attachment.name)}</li>)}</ul> : null}
      {message.error ? <p className="ob-msg-error" role="alert">{agentText(message.error)}</p> : null}
    </div>
  </article>
})

/** Local snapshots only: never changes the current chat or calls an executor. */
export function AgentTranscript({ sessionId, botId, zh, running, watching, backendId }: {
  sessionId: string; botId: string; zh: boolean; running: boolean; watching: boolean; backendId?: string
}): ReactNode {
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot>({ phase: 'loading', messages: [], liveUnavailable: false })
  const reader = useRef<ReturnType<typeof observeAgentSession> | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [visibleCount, setVisibleCount] = useState(60)
  const [earlierLoading, setEarlierLoading] = useState(false)
  const [, historyChanged] = useState(0)
  useEffect(() => window.openbot.history?.subscribe(() => historyChanged(n => n + 1)), [])
  const pendingScroll = useRef<{ height: number; top: number } | null>(null)
  const scroll = useStickyScroll(geometry => setShowJump(showsJump(geometry)))
  useEffect(() => {
    const next = observeAgentSession({ get: id => window.openbot.sessions.get(id), live: id => window.openbot.agent.liveMessages(id), on: listener => window.openbot.on(listener), watch: id => window.openbot.sessions.watch?.('agent', id) ?? Promise.resolve() }, sessionId, botId, setSnapshot)
    reader.current = next
    return () => { next.dispose(); if (reader.current === next) reader.current = null }
  }, [sessionId, botId])
  useEffect(() => { reader.current?.setRunning(watching) }, [sessionId, botId, watching])
  const messages = snapshot.messages
  const activities = useMemo(() => agentActivities(messages, running), [snapshot.activityVersion, running])
  const byOwner = useMemo(() => {
    const byOwner = new Map<string, AgentActivity[]>()
    for (const activity of activities) {
      const owned = byOwner.get(activity.owner)
      if (owned) owned.push(activity)
      else byOwner.set(activity.owner, [activity])
    }
    return byOwner
  }, [activities])
  useEffect(() => { setVisibleCount(60); pendingScroll.current = null }, [sessionId])
  const rows = messages.slice(-visibleCount)
  useEffect(() => {
    const scroller = scroll.scrollerRef.current, anchor = pendingScroll.current
    if (scroller && anchor) scroller.scrollTop = anchor.top + scroller.scrollHeight - anchor.height
    pendingScroll.current = null
  }, [visibleCount, messages.length])
  const more = window.openbot.history?.hasMore(sessionId) === true
  const earlier = async () => {
    if (earlierLoading) return
    const saveAnchor = () => { const scroller = scroll.scrollerRef.current; if (scroller) pendingScroll.current = { height: scroller.scrollHeight, top: scroller.scrollTop } }
    saveAnchor()
    if (messages.length > visibleCount) { setVisibleCount(value => value + 60); return }
    setEarlierLoading(true)
    try { await window.openbot.history?.loadEarlier(sessionId, saveAnchor); setVisibleCount(value => value + 60); reader.current?.refresh() }
    finally { setEarlierLoading(false) }
  }
  const labels = {
    missing: zh ? '当前未读取到执行会话；记录可能已移除或暂时无法读取。' : 'No execution session could be read. It may have been removed or be temporarily unavailable.',
    unavailable: zh ? '此执行会话不属于该任务的 Bot，无法展示。' : 'This execution session does not belong to the task’s Bot.',
    error: zh ? '无法刷新执行会话，已显示的记录可能不是最新状态。' : 'Could not refresh the session. Displayed records may be out of date.'
  }
  return <div className="ob-transcript ob-agent-transcript" aria-label={zh ? 'Agent 执行会话' : 'Agent execution session'}>
    <div className="ob-transcript-scroller" ref={scroll.scrollerRef} onScroll={scroll.onScroll} tabIndex={0}>
      <div className="ob-transcript-content ob-agent-transcript-content" ref={scroll.contentRef}>
        <p className="ob-hint">{zh ? '只读执行记录 · 仅展示应用收到的消息和活动。' : 'Read-only execution record · Messages and activities received by the app.'}{backendId === 'grok' ? (zh ? ' Grok 可能不提供部分工具结果。' : ' Grok may omit some tool results.') : ''}</p>
        {snapshot.phase === 'loading' ? <p role="status">{zh ? '正在读取执行会话…' : 'Loading execution session…'}</p> : null}
        {snapshot.phase in labels ? <p role="alert">{labels[snapshot.phase as keyof typeof labels]} {snapshot.phase === 'error' ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => reader.current?.refresh()}>{zh ? '重试' : 'Retry'}</button> : null}</p> : null}
        {snapshot.liveUnavailable ? <p role="status" className="ob-hint">{zh ? '实时记录暂不可用，当前显示已保存内容。' : 'Live records are unavailable. Showing saved messages.'}</p> : null}
        {snapshot.phase === 'ready' && !rows.length ? <p className="ob-agent-empty">{zh ? '暂时没有可展示的执行消息。' : 'No execution messages are available yet.'}</p> : null}
        {messages.length > visibleCount || more ? <button type="button" className="ob-btn ob-btn-sm ob-agent-earlier" disabled={earlierLoading} onClick={() => void earlier().catch(() => reader.current?.refresh())}>{earlierLoading ? 'Loading…' : zh ? '显示更早的消息' : 'Show earlier messages'}{messages.length > visibleCount ? ` (${messages.length - visibleCount})` : ''}</button> : null}
        {rows.map(message => <AgentMessage key={message.id} message={message} steps={byOwner.get(message.id) ?? NO_STEPS} running={running && Boolean(message.streaming)} zh={zh} />)}
        {snapshot.phase === 'ready' && rows.length > 0 && !activities.length ? <p className="ob-hint">{zh ? '此会话尚无工具活动记录；这不表示任务没有使用工具。' : 'No tool activities were recorded. This does not imply that no tools were used.'}</p> : null}
      </div>
    </div>
    {showJump ? <button type="button" className="ob-transcript-jump" onClick={() => { scroll.jump(); setShowJump(false) }}>{zh ? '回到最新' : 'Jump to latest'}</button> : null}
  </div>
}
