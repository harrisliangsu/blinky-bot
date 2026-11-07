import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agentText, type AgentActivity } from './agentTaskPresentation'
import { IconChevronDown, IconChevronRight } from './Icons'
import { ToolCallView } from './ToolCallView'
import './AgentThinking.css'

const TEXT_PAGE = 4000
const TOOL_PAGE = 30

function RecordedText({ text, zh }: { text: string; zh: boolean }): ReactNode {
  const [limit, setLimit] = useState(TEXT_PAGE)
  return <>
    <pre tabIndex={0}>{text.slice(0, limit)}</pre>
    {text.length > TEXT_PAGE ? <button type="button" className="ob-btn ob-btn-sm ob-agent-text-more" disabled={limit >= text.length} onClick={() => setLimit(value => value + TEXT_PAGE)}>
      {limit >= text.length ? (zh ? '已显示全部记录' : 'All recorded text shown') : (zh ? '继续显示记录' : 'Show more recorded text')}
      {limit < text.length ? ` (${text.length - limit})` : ''}
    </button> : null}
  </>
}

/** Unknown is a real absence of evidence, not an eternally running tool.
 * Like ToolCallView, mount expensive arguments/output only after disclosure. */
function UnknownTool({ activity, zh }: { activity: AgentActivity; zh: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const body = useId()
  return <div className="ob-tool ob-agent-tool-unknown">
    <button type="button" className="ob-tool-row" aria-expanded={open} aria-controls={body} onClick={() => setOpen(value => !value)}>
      <span className="ob-tool-caret" aria-hidden="true">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      <span className="ob-tool-name">{activity.call.name}</span>
      <span className="ob-tool-summary">{zh ? '结果未记录' : 'Result not recorded'}</span>
    </button>
    <div id={body} hidden={!open}>
      {open ? <div className="ob-tool-detail">
        <dl className="ob-tool-args">{Object.entries(activity.call.args).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>
        {activity.output ? <pre className="ob-tool-output" tabIndex={0}>{activity.output.slice(0, 8000)}{activity.output.length > 8000 ? (zh ? '\n… 输出已截断' : '\n… Output truncated') : ''}</pre> : null}
        <p className="ob-hint">{zh ? '记录未提供确定的工具结果，不能据此判断成功。' : 'No definitive tool result was recorded. Success cannot be inferred.'}</p>
      </div> : null}
    </div>
  </div>
}

const Activity = memo(function Activity({ activity, zh }: { activity: AgentActivity; zh: boolean }): ReactNode {
  const labels = {
    running: zh ? '进行中' : 'Running', ok: zh ? '成功' : 'Succeeded',
    failed: zh ? '失败或已中断' : 'Failed or interrupted', unknown: zh ? '结果未记录' : 'Result not recorded'
  }
  return <div className={`ob-agent-activity ob-agent-activity-${activity.status}`}>
    <span className="ob-agent-activity-state">{labels[activity.status]}</span>
    {activity.status === 'unknown' ? <UnknownTool activity={activity} zh={zh} /> : <ToolCallView call={activity.call} result={activity.result} />}
    {activity.incomplete ? <small className="ob-hint">{zh ? '部分活动记录缺失或已压缩。' : 'Some activity details are missing or compacted.'}</small> : null}
  </div>
})

/** Recorded thinking and public commentary are separate from answer content.
 * No ordering between reasoning and tools is invented: Message has no shared
 * timestamps for those channels. Each tool retains its own recorded order. */
export function AgentThinking({ reasoning, steps, commentary, running, zh }: {
  reasoning: string; steps: AgentActivity[]; commentary: string; running: boolean; zh: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [visibleSteps, setVisibleSteps] = useState(TOOL_PAGE)
  const body = useId(), heading = useId()
  const root = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ scroller: HTMLElement; height: number; top: number } | null>(null)
  const counts = useMemo(() => {
    const failed = steps.filter(step => step.status === 'failed').length
    const pending = steps.filter(step => step.status === 'running').length
    const unknown = steps.filter(step => step.status === 'unknown').length
    return [
      steps.length ? (zh ? `${steps.length} 次工具调用` : `${steps.length} tool calls`) : '',
      pending ? (zh ? `${pending} 进行中` : `${pending} running`) : '',
      failed ? (zh ? `${failed} 失败或中断` : `${failed} failed or interrupted`) : '',
      unknown ? (zh ? `${unknown} 结果未记录` : `${unknown} without recorded results`) : ''
    ].filter(Boolean).join(' · ')
  }, [steps, zh])
  useLayoutEffect(() => {
    const previous = anchor.current
    if (previous) previous.scroller.scrollTop = previous.top + previous.scroller.scrollHeight - previous.height
    anchor.current = null
  }, [visibleSteps])
  if (!(reasoning || steps.length || commentary)) return null
  return <div ref={root} className={`ob-agent-thinking${running ? ' is-live' : ''}`}>
    <button type="button" id={heading} className="ob-agent-thinking-toggle" aria-expanded={open} aria-controls={body} onClick={() => setOpen(value => !value)}>
      <span className="ob-agent-thinking-caret" aria-hidden="true">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
      <span>{zh ? '思考与工具活动' : 'Thinking and tool activity'}</span>
      {running ? <span className="ob-agent-thinking-live">{zh ? '进行中' : 'In progress'}</span> : null}
      {counts ? <span className="ob-agent-thinking-counts">{counts}</span> : null}
    </button>
    <section id={body} aria-labelledby={heading} hidden={!open}>
      {open ? <div className="ob-agent-thinking-body">
        <p className="ob-hint">{zh ? '仅展示收到的记录；未提供的思考或工具结果不会补写。' : 'Received records only. Unavailable thinking and tool results are not reconstructed.'}</p>
        {reasoning ? <div className="ob-agent-thinking-record"><h4>{zh ? '思考记录' : 'Recorded thinking'}</h4><RecordedText text={agentText(reasoning)} zh={zh} /></div> : null}
        {commentary ? <div className="ob-agent-thinking-record ob-agent-thinking-commentary"><h4>{zh ? '进度记录' : 'Progress updates'}</h4><RecordedText text={agentText(commentary)} zh={zh} /></div> : null}
        {steps.length ? <div className="ob-agent-thinking-tools"><h4>{zh ? '工具活动' : 'Tool activity'}</h4>
          {steps.length > TOOL_PAGE ? <button type="button" className="ob-btn ob-btn-sm ob-agent-tools-earlier" disabled={visibleSteps >= steps.length} onClick={() => {
            const scroller = root.current?.closest<HTMLElement>('.ob-transcript-scroller')
            if (scroller) anchor.current = { scroller, height: scroller.scrollHeight, top: scroller.scrollTop }
            setVisibleSteps(value => value + TOOL_PAGE)
          }}>{visibleSteps >= steps.length ? (zh ? '已显示全部工具活动' : 'All tool activity shown') : (zh ? '显示更早的工具活动' : 'Show earlier tool activity')}{visibleSteps < steps.length ? ` (${steps.length - visibleSteps})` : ''}</button> : null}
          <ol aria-label={zh ? '收到的工具活动' : 'Received tool activity'}>{steps.slice(-visibleSteps).map(activity => <li key={activity.id}><Activity activity={activity} zh={zh} /></li>)}</ol>
        </div> : null}
      </div> : null}
    </section>
  </div>
}
