import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AgentTaskClarification, AgentTaskQuestion } from '../../../shared/types'
import './TaskClarificationCard.css'

export interface TaskClarificationCardProps {
  request: AgentTaskClarification
  zh: boolean
  taskTitle?: string
  /** Resolve only with the canonical application receipt; a submitted request
   * is not evidence that the executor has consumed the answer. */
  onCancel?: (id: string) => Promise<AgentTaskClarification>
  onAnswer: (id: string, answers: Record<string, string[]>) => Promise<AgentTaskClarification>
}

interface Draft { option?: string; custom: boolean; text: string }
const EMPTY: Draft = { custom: false, text: '' }

function AnswerField({ question, value, disabled, invalid, zh, onChange }: {
  question: AgentTaskQuestion; value: Draft; disabled: boolean; invalid: boolean; zh: boolean; onChange: (draft: Draft) => void
}): ReactNode {
  const id = useId(), hint = `${id}-hint`, error = `${id}-error`
  const options = question.options ?? []
  const custom = !options.length || value.custom
  return <fieldset className="ob-clarification-question" disabled={disabled}>
    <legend>{question.header ? <span className="ob-clarification-question-header">{question.header}</span> : null}{question.question}</legend>
    {options.length ? <div className="ob-clarification-options">{options.map((option, index) => <label key={`${index}-${option.label}`} className="ob-clarification-option">
      <input type="radio" name={id} value={option.label} checked={!value.custom && value.option === option.label} onChange={() => onChange({ ...value, custom: false, option: option.label })} />
      <span><span className="ob-clarification-option-title"><b className="ob-clarification-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</b>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</span>
    </label>)}<label className="ob-clarification-option">
      <input type="radio" name={id} checked={value.custom} onChange={() => onChange({ ...value, custom: true })} />
      <span>{zh ? '自行填写回答' : 'Write an answer'}</span>
    </label></div> : null}
    <label className="ob-clarification-input-label" htmlFor={`${id}-answer`}>{zh ? '你的回答' : 'Your answer'}</label>
    {question.isSecret ? <input id={`${id}-answer`} className="ob-input ob-clarification-input" type="password" autoComplete="new-password" spellCheck={false} value={value.text} aria-describedby={`${hint}${invalid ? ` ${error}` : ''}`} aria-invalid={invalid || undefined} onFocus={() => { if (!custom) onChange({ ...value, custom: true }) }} onChange={event => onChange({ ...value, custom: true, text: event.target.value })} />
      : <textarea id={`${id}-answer`} className="ob-input ob-clarification-input" rows={2} value={value.text} aria-describedby={`${hint}${invalid ? ` ${error}` : ''}`} aria-invalid={invalid || undefined} onFocus={() => { if (!custom) onChange({ ...value, custom: true }) }} onChange={event => onChange({ ...value, custom: true, text: event.target.value })} />}
    <p id={hint} className="ob-clarification-hint">{question.isSecret ? (zh ? '此回答不会在卡片中回显。' : 'This answer will not be displayed in the card.') : options.length ? (zh ? '选择一个建议，或填写自己的回答。' : 'Choose a suggestion or write your own answer.') : (zh ? '请补充完成这项工作所需的信息。' : 'Add the information needed to continue this work.')}</p>
    {invalid ? <p id={error} className="ob-clarification-error">{zh ? '请回答这个问题。' : 'Please answer this question.'}</p> : null}
  </fieldset>
}

function ClarificationBody({ request, zh, taskTitle, onAnswer, onCancel }: TaskClarificationCardProps): ReactNode {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [receipt, setReceipt] = useState<AgentTaskClarification | null>(null)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [attempted, setAttempted] = useState(false)
  const alive = useRef(true), submitting = useRef(false), form = useRef<HTMLFormElement>(null)
  const heading = useId()
  const current = receipt && receipt.updatedAt >= request.updatedAt ? receipt : request
  const waiting = current.status === 'waiting_user'
  const questions = current.questions.filter(question => !current.botAnswers?.[question.id])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!waiting) { setDrafts({}); setFailed(false) }
  }, [waiting])
  const answerFor = (question: AgentTaskQuestion): string => {
    const value = drafts[question.id] ?? EMPTY
    return (!question.options?.length || value.custom ? value.text.trim() : value.option) ?? ''
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!waiting || submitting.current) return
    setAttempted(true)
    if (!questions.length || questions.some(question => !answerFor(question))) {
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    submitting.current = true; setBusy(true); setFailed(false)
    try {
      const next = await onAnswer(current.id, Object.fromEntries(questions.map(question => [question.id, [answerFor(question)]])))
      if (!alive.current) return
      if (next.id !== current.id || next.status === 'waiting_user' || next.status === 'answering') { setFailed(true); return }
      setReceipt(next)
      if (next.status !== 'answered') setFailed(false)
    } catch { if (alive.current) setFailed(true) }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  const cancel = async (): Promise<void> => {
    if ((!waiting && !(current.status === 'cancelled' && current.persistenceError)) || submitting.current || !onCancel) return
    submitting.current = true; setBusy(true); setFailed(false)
    try { const next = await onCancel(current.id); if (alive.current) setReceipt(next) }
    catch { if (alive.current) setFailed(true) }
    finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  const status = current.status === 'answered'
    ? (zh ? (current.answeredBy === 'bot' ? 'Bot 已根据上下文回答。' : '回答已接收。') : (current.answeredBy === 'bot' ? 'The Bot answered using the conversation context.' : 'Answer received.'))
    : current.status === 'cancelled' ? (zh ? '此问题已取消，未提供回答。' : 'This question was cancelled. No answer was supplied.')
      : current.status === 'expired' ? (zh ? '这个问题已失效，请等待新的问题。' : 'This question has expired. Wait for a new question.')
        : current.status === 'failed' ? (zh ? '这个问题当前无法处理，请等待更新。' : 'This question cannot be processed. Wait for an update.')
          : busy ? (zh ? '正在提交回答…' : 'Submitting answer…') : (zh ? '请补充信息，以便继续。' : 'Add the information needed to continue.')
  return <section className="ob-task-clarification" aria-labelledby={heading} data-task-clarification-id={current.id} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <header><h3 id={heading}>{waiting ? (zh ? '需要你补充' : 'Your input is needed') : (zh ? '补充信息' : 'Additional information')}</h3>{taskTitle ? <p className="ob-clarification-task">{taskTitle}</p> : null}</header>
    <p className="ob-clarification-status" role="status" aria-live="polite">{status}</p>
    {waiting && current.botResolutionUnavailable ? <p className="ob-clarification-status" role="status" data-bot-resolution-unavailable={current.botResolutionUnavailable}>{zh
      ? current.botResolutionUnavailable === 'permission-required' ? 'Bot 的内部判断需要本机执行权限，当前未运行。请直接回答此问题；这不会授予文件或执行权限。'
        : current.botResolutionUnavailable === 'native-tools-unavailable' ? '当前 Bot 的原生 CLI 无法保证关闭本机工具，未运行自动判断。请直接回答此问题；现有权限保持有效。'
          : current.botResolutionUnavailable === 'local-execution-denied' ? '当前权限禁止本机执行，Bot 未运行内部判断。请直接回答此问题；这不会更改权限。'
            : 'Bot 暂时无法完成内部判断，请直接回答此问题。'
      : current.botResolutionUnavailable === 'permission-required' ? 'The Bot could not run its internal judgment without local execution approval. Answer this question directly; this does not grant file or execution permission.'
        : current.botResolutionUnavailable === 'native-tools-unavailable' ? 'This Bot’s native CLI cannot guarantee disabling local tools, so automatic judgment did not run. Answer directly; existing permissions still apply.'
          : current.botResolutionUnavailable === 'local-execution-denied' ? 'Local execution is denied, so the Bot did not run its internal judgment. Answer directly; permissions are unchanged.'
            : 'The Bot could not complete its internal judgment. Please answer directly.'}</p> : null}
    {current.persistenceError ? <div><p className="ob-clarification-error" role="alert">{current.persistenceError}</p>{onCancel && current.status === 'cancelled' ? <button type="button" className="ob-btn" disabled={busy} onClick={() => { void cancel() }}>{zh ? '重试保存关闭记录' : 'Retry saving closure'}</button> : null}</div> : null}
    {waiting ? <form ref={form} onSubmit={event => { void submit(event) }} aria-busy={busy}>
      {questions.map(question => <AnswerField key={question.id} question={question} zh={zh} value={drafts[question.id] ?? EMPTY} disabled={busy} invalid={attempted && !answerFor(question)} onChange={value => { setDrafts(previous => ({ ...previous, [question.id]: value })); setFailed(false) }} />)}
      {!questions.length ? <p role="alert" className="ob-clarification-error">{zh ? '当前问题不可用，请等待更新。' : 'No question is available. Wait for an update.'}</p> : null}
      {failed ? <p role="alert" className="ob-clarification-error">{zh ? '回答尚未被接收，请重试。你的输入已保留。' : 'The answer was not received. Try again; your input has been kept.'}</p> : null}
      <div className="ob-clarification-actions">{onCancel ? <button type="button" className="ob-btn" disabled={busy} onClick={() => { void cancel() }}>{zh ? '取消问题' : 'Cancel question'}</button> : null}<button type="submit" className="ob-btn ob-btn-primary" disabled={busy || !questions.length}>{busy ? (zh ? '正在提交…' : 'Submitting…') : (zh ? '提交回答' : 'Submit answer')}</button></div>
    </form> : <dl className="ob-clarification-answers">{current.questions.map(question => <div key={question.id}><dt>{question.question}</dt><dd>{question.isSecret ? (zh ? '敏感回答已隐藏' : 'Sensitive answer hidden') : current.answers?.[question.id]?.join(' · ') || (zh ? '未记录回答' : 'No answer recorded')}</dd></div>)}</dl>}
  </section>
}

/** The Bot gets the first opportunity to answer. Do not flash a user card
 * while that attempt is still running, and never submit without user action. */
export function TaskClarificationCard(props: TaskClarificationCardProps): ReactNode {
  if (props.request.status === 'answering') return null
  return <ClarificationBody key={props.request.id} {...props} />
}
