import { useEffect, useState, type ReactNode } from 'react'
import type { SlackDraft } from '../../../shared/drafts'
import { useBotChinese } from './BotUiLanguage'
import './GitHubDraftCards.css'

export function SlackDraftCards({sessionId}:{sessionId:string}):ReactNode{
  const zh=useBotChinese(),[items,setItems]=useState<SlackDraft[]>([]),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('')
  useEffect(()=>{let active=true,changed=false;setItems([]);setError('')
    void window.openbot.slackDrafts.list(sessionId).then((r)=>{if(!active)return;if(!r.ok)setError(r.error??(zh?'草稿读取失败。':'Could not read drafts.'));else if(!changed)setItems(r.drafts??[]);else setItems((old)=>[...(r.drafts??[]).filter((d)=>!old.some((v)=>v.id===d.id)),...old])}).catch(()=>{if(active)setError(zh?'草稿读取失败。':'Could not read drafts.')})
    const stop=window.openbot.on((event)=>{if(event.type!=='slack-draft-updated'||event.draft.sessionId!==sessionId)return;changed=true;setItems((old)=>[...old.filter((d)=>d.id!==event.draft.id),event.draft])})
    return()=>{active=false;stop()}
  },[sessionId,zh])
  async function act(draft:SlackDraft,action:'send'|'cancel'):Promise<void>{if(busy)return;setBusy(draft.id);setError('');try{const r=await window.openbot.slackDrafts.act(draft.id,sessionId,action);if(!r.ok)setError(r.error??(zh?'操作未完成。':'Action failed.'));else if(r.draft)setItems((old)=>old.map((v)=>v.id===draft.id?r.draft!:v))}catch{setError(zh?'操作未完成，请检查草稿状态。':'Action failed; check the draft.')}finally{setBusy(null)}}
  return <>{items.map((draft)=><section className="ob-github-draft" key={draft.id} aria-label={zh?'Slack 消息草稿':'Slack message draft'}>
    <strong>{draft.status==='sent'?(zh?'Slack 消息已发送':'Slack message sent'):draft.status==='cancelled'?(zh?'Slack 消息已取消':'Slack message cancelled'):(zh?'Slack 消息草稿':'Slack message draft')}</strong>
    <p className="ob-github-draft-target">{draft.teamId} · {draft.channelId}{draft.threadTs?` · ${zh?'回复线程':'Thread'} ${draft.threadTs}`:''}</p><div className="ob-github-draft-body">{draft.text}</div>
    {draft.status==='draft'?<div className="ob-github-draft-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={()=>void act(draft,'cancel')}>{zh?'取消草稿':'Cancel draft'}</button><button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!!busy} onClick={()=>void act(draft,'send')}>{zh?'确认发送':'Send message'}</button></div>:null}
    {draft.status==='sending'?<p>{zh?'正在发送…':'Sending…'}</p>:null}{draft.status==='uncertain'?<p role="alert">{zh?'发送结果未确认，请先检查 Slack；应用不会自动重发。':'Send result is uncertain. Check Slack before retrying; the app will not resend automatically.'}</p>:null}
    {draft.feedbackStatus==='uncertain'?<p role="alert">{zh?'Bot 是否处理这条结果尚未确认，请检查聊天。':'It is unclear whether the Bot processed this receipt; check the conversation.'}</p>:null}
  </section>)}{error?<p role="alert">{error}</p>:null}</>
}
