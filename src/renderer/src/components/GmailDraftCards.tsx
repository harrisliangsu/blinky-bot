import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { GmailDraft } from '../../../shared/drafts'
import { useBotChinese } from './BotUiLanguage'
import './GitHubDraftCards.css'
import './OutboundSendRules.css'

/** Presence in this visible viewport is an acknowledgment, never proof of reading. */
function GmailDraftSurface({draft,sessionId,children,label}:{draft:GmailDraft;sessionId:string;children:ReactNode;label:string}):ReactNode{
  const ref=useRef<HTMLElement>(null)
  useEffect(()=>{
    if(draft.status!=='draft')return
    let active=true,submitted=false
    const present=():void=>{
      const node=ref.current;if(!active||submitted||!node||document.visibilityState!=='visible')return
      const r=node.getBoundingClientRect()
      if(r.width<=0||r.height<=0||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return
      if(typeof window.openbot.gmailDrafts.presented!=='function')return
      submitted=true
      void window.openbot.gmailDrafts.presented(draft.id,sessionId,draft.updatedAt).then(ok=>{if(active&&!ok)submitted=false}).catch(()=>{if(active)submitted=false})
    }
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))present()}):null
    if(ref.current)observer?.observe(ref.current)
    document.addEventListener('visibilitychange',present);window.addEventListener('scroll',present,true);window.addEventListener('resize',present);present()
    return()=>{active=false;observer?.disconnect();document.removeEventListener('visibilitychange',present);window.removeEventListener('scroll',present,true);window.removeEventListener('resize',present)}
  },[draft.id,draft.updatedAt,draft.status,sessionId])
  return<section ref={ref} className="ob-github-draft" data-gmail-draft-id={draft.id} aria-label={label}>{children}</section>
}

export function GmailDraftCards({ sessionId }: { sessionId: string }): ReactNode {
  const zh = useBotChinese()
  const [items, setItems] = useState<GmailDraft[]>([]), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true, changed = false
    setItems([]); setError('')
    void window.openbot.gmailDrafts.list(sessionId).then((result) => {
      if (!active) return
      if (!result.ok) setError(result.error ?? (zh ? '草稿读取失败。' : 'Could not read drafts.'))
      else if (!changed) setItems(result.drafts ?? [])
      else setItems((old) => [...(result.drafts ?? []).filter((draft) => !old.some((item) => item.id === draft.id)), ...old])
    }).catch(() => { if (active) setError(zh ? '草稿读取失败。' : 'Could not read drafts.') })
    const stop = window.openbot.on((event) => {
      if (event.type !== 'gmail-draft-updated' || event.draft.sessionId !== sessionId) return
      changed = true; setItems((old) => [...old.filter((draft) => draft.id !== event.draft.id), event.draft])
    })
    return () => { active = false; stop() }
  }, [sessionId, zh])
  async function act(draft: GmailDraft, action: 'send' | 'cancel'): Promise<void> {
    if (busy) return
    setBusy(draft.id); setError('')
    try {
      const result = await window.openbot.gmailDrafts.act(draft.id, sessionId, action); if (!result.ok) setError(result.error ?? (zh ? '操作未完成。' : 'Action failed.')); else if (result.draft) setItems((old) => old.map((item) => item.id === draft.id ? result.draft! : item))
    }
    catch { setError(zh ? '操作未完成，请检查草稿状态。' : 'Action failed; check the draft.') } finally { setBusy(null) }
  }
  return <>
    {items.map((draft) => <GmailDraftSurface draft={draft} sessionId={sessionId} key={draft.id} label={zh ? 'Gmail 邮件草稿' : 'Gmail draft'}>
      <strong>{draft.status === 'sent' ? (zh ? 'Gmail 已接受发送' : 'Accepted by Gmail') : draft.status === 'cancelled' ? (zh ? '邮件已取消' : 'Email cancelled') : (zh ? '邮件草稿' : 'Email draft')}</strong>
      <p className="ob-github-draft-target">{zh ? '发件人' : 'From'}：{draft.senderAccount}<br />{zh ? '收件人' : 'To'}：{draft.to}<br />{zh ? '主题' : 'Subject'}：{draft.subject}</p>
      <div className="ob-github-draft-body">{draft.body}</div>
      {draft.status === 'draft' ? <>
        <div className="ob-github-draft-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={() => void act(draft, 'cancel')}>{zh ? '取消草稿' : 'Cancel draft'}</button><button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!!busy} onClick={() => void act(draft, 'send')}>{zh ? '确认发送' : 'Send email'}</button></div>
      </> : null}
      {draft.sendAuthorization?<p>{zh?'已使用你保存的精确收件人发送规则。':'Used your saved rule for this exact sender and recipient.'}</p>:null}
      {draft.sendNotStarted?<p role="status">{zh?'发送已在发出前停止，邮件未发送。再次发送仍需确认。':'Stopped before sending. No message was sent; a new confirmation is required.'}</p>:null}
      {draft.status === 'sending' ? <p>{zh ? '正在发送…' : 'Sending…'}</p> : null}
      {draft.status === 'uncertain' ? <p role="alert">{zh ? '发送结果未确认，请先检查 Gmail 已发送邮件；应用不会自动重发。' : 'Send result is uncertain. Check Gmail Sent before retrying; the app will not resend automatically.'}</p> : null}
      {draft.status === 'sent' ? <p>{zh ? 'Gmail 已接收发送请求；是否送达对方尚未确认。' : 'Gmail accepted the request; delivery to the recipient is not confirmed.'}</p> : null}
      {draft.feedbackStatus === 'uncertain' ? <p role="alert">{zh ? 'Bot 是否处理这条结果尚未确认，请检查聊天。' : 'It is unclear whether the Bot processed this receipt; check the conversation.'}</p> : null}
    </GmailDraftSurface>)}
    {error ? <p role="alert">{error}</p> : null}
  </>
}
