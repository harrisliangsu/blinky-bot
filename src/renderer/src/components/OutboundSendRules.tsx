import { useEffect, useState, type ReactNode } from 'react'
import type { GmailSendRule } from '../../../shared/sendRules'
import { useBotChinese } from './BotUiLanguage'
import './OutboundSendRules.css'

/** User-owned exemptions; models have no API for adding or changing these. */
export function OutboundSendRules():ReactNode{
  const zh=useBotChinese(),[rules,setRules]=useState<GmailSendRule[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string|null>(null)
  useEffect(()=>{
    let active=true,revision=0
    const refresh=async()=>{const request=++revision;try{const result=await window.openbot.sendRules.list();if(!active||request!==revision)return;if(!result.ok)setError(result.error??(zh?'无法读取发送规则。':'Could not read send rules.'));else{setRules(result.rules??[]);setError('')}}catch{if(active&&request===revision)setError(zh?'无法读取发送规则。':'Could not read send rules.')}}
    void refresh()
    const stop=window.openbot.on(event=>{if(event.type==='send-rules-updated')void refresh()})
    return()=>{active=false;stop()}
  },[zh])
  async function remove(id:string):Promise<void>{if(busy)return;setBusy(id);setError('');try{const result=await window.openbot.sendRules.remove(id);if(!result.ok)setError(result.error??(zh?'未能撤销规则。':'Could not revoke the rule.'));else setRules(old=>old.filter(rule=>rule.id!==id))}catch{setError(zh?'未能撤销规则。':'Could not revoke the rule.')}finally{setBusy(null)}}
  return<section className="ob-set-card ob-send-rules" aria-label={zh?'自动发送规则':'Automatic send rules'}>
    <h3>{zh?'自动发送规则':'Automatic send rules'}</h3>
    <p className="ob-hint">{zh?'在邮件草稿中明确保存后，后续匹配 Gmail 发件人和精确收件人的新邮件可自动发送。未匹配的邮件仍需确认；取消或结果未确认的发送不会自动重试。':'Save an explicit rule on a mail draft to allow future new messages from that Gmail account to that exact recipient. Other messages still need confirmation. Cancelled or uncertain sends are never retried automatically.'}</p>
    {rules.length?<ul>{rules.map(rule=><li key={rule.id} data-send-rule-id={rule.id}><span><strong>Gmail · {rule.senderAccount}</strong><small>{zh?'收件人':'To'}：{rule.to}</small></span><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={()=>void remove(rule.id)}>{zh?'撤销规则':'Revoke rule'}</button></li>)}</ul>:<p className="ob-hint">{zh?'尚未保存自动发送规则。':'No automatic send rules saved.'}</p>}
    {error?<p role="alert">{error}</p>:null}
  </section>
}
