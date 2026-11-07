import { useEffect, useState, type ReactNode } from 'react'
import type { CalendarDraft } from '../../../shared/drafts'
import { useBotChinese } from './BotUiLanguage'
import './GitHubDraftCards.css'

export function CalendarDraftCards({ sessionId }: { sessionId: string }): ReactNode {
  const zh = useBotChinese()
  const [items, setItems] = useState<CalendarDraft[]>([]), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true, changed = false
    setItems([]); setError('')
    void window.openbot.calendarDrafts.list(sessionId).then((result) => {
      if (!active) return
      if (!result.ok) setError(result.error ?? (zh ? '草稿读取失败。' : 'Could not read drafts.'))
      else if (!changed) setItems(result.drafts ?? [])
      else setItems((old) => [...(result.drafts ?? []).filter((draft) => !old.some((item) => item.id === draft.id)), ...old])
    }).catch(() => { if (active) setError(zh ? '草稿读取失败。' : 'Could not read drafts.') })
    const stop = window.openbot.on((event) => {
      if (event.type !== 'calendar-draft-updated' || event.draft.sessionId !== sessionId) return
      changed = true; setItems((old) => [...old.filter((draft) => draft.id !== event.draft.id), event.draft])
    })
    return () => { active = false; stop() }
  }, [sessionId, zh])
  async function act(draft: CalendarDraft, action: 'send' | 'cancel'): Promise<void> {
    if (busy) return
    setBusy(draft.id); setError('')
    try { const result = await window.openbot.calendarDrafts.act(draft.id, sessionId, action); if (!result.ok) setError(result.error ?? (zh ? '操作未完成。' : 'Action failed.')); else if (result.draft) setItems((old) => old.map((item) => item.id === draft.id ? result.draft! : item)) }
    catch { setError(zh ? '操作未完成，请检查草稿状态。' : 'Action failed; check the draft.') } finally { setBusy(null) }
  }
  return <>
    {items.map((draft) => <section className="ob-github-draft" key={draft.id} aria-label={zh ? '日程草稿' : 'Calendar draft'}>
      <strong>{draft.status === 'sent' ? (zh ? '日程已创建' : 'Event created') : draft.status === 'cancelled' ? (zh ? '日程已取消' : 'Event cancelled') : (zh ? '日程草稿' : 'Calendar draft')}</strong>
      <p className="ob-github-draft-target">{zh ? '日历账户' : 'Calendar account'}：{draft.account}<br />{zh ? '标题' : 'Title'}：{draft.summary}<br />{zh ? '开始' : 'Start'}：{draft.start}<br />{zh ? '结束' : 'End'}：{draft.end}</p>
      {draft.attendees?.length ? <p className="ob-github-draft-target">{zh ? '参会人（确认后将发送邀请）' : 'Guests (invitations will be sent after confirmation)'}：{draft.attendees.join(', ')}</p> : null}
      {draft.description ? <div className="ob-github-draft-body">{draft.description}</div> : null}
      {draft.status === 'sent' && draft.attendees?.length ? <p className="ob-hint">{zh ? '已请求日历服务发送邀请；送达状态请在日历中查看。' : 'The calendar service was asked to send invitations; check the calendar for delivery status.'}</p> : null}
      {draft.status === 'draft' ? <div className="ob-github-draft-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={() => void act(draft, 'cancel')}>{zh ? '取消草稿' : 'Cancel draft'}</button><button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!!busy} onClick={() => void act(draft, 'send')}>{draft.attendees?.length ? (zh ? '创建并发送邀请' : 'Create and invite') : (zh ? '确认创建' : 'Create event')}</button></div> : null}
      {draft.status === 'sending' ? <p>{zh ? '正在创建…' : 'Creating…'}</p> : null}
      {draft.status === 'uncertain' ? <p role="alert">{zh ? '创建结果未确认，请先检查日历；应用不会自动重试。' : 'Creation is uncertain. Check your calendar; the app will not automatically retry.'}</p> : null}
      {draft.feedbackStatus === 'uncertain' ? <p role="alert">{zh ? 'Bot 是否处理这条结果尚未确认，请检查聊天。' : 'It is unclear whether the Bot processed this receipt; check the conversation.'}</p> : null}
    </section>)}
    {error ? <p role="alert">{error}</p> : null}
  </>
}
