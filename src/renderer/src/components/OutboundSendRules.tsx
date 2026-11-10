import { useEffect, useState, type ReactNode } from 'react'
import type { GmailSendRule } from '../../../shared/sendRules'
import { useBotChinese } from './BotUiLanguage'
import './OutboundSendRules.css'

/** Leftover rules can be revoked. They do not send mail. */
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
  return<section className="ob-set-card ob-send-rules" aria-label={zh?'已停用的发送规则':'Retired send rules'}>
    <h3>{zh?'自动发送已停用':'Automatic sending is off'}</h3>
    <p className="ob-hint">{zh?'保存的规则不会再自动发送邮件。每封邮件仍需单独确认。可以撤销以前留下的规则。':'Saved rules no longer send mail. Each message still needs its own confirmation. You can revoke rules left from before.'}</p>
    {rules.length?<ul>{rules.map(rule=><li key={rule.id} data-send-rule-id={rule.id}><span><strong>Gmail · {rule.senderAccount}</strong><small>{zh?'收件人':'To'}：{rule.to}</small></span><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={()=>void remove(rule.id)}>{zh?'撤销规则':'Revoke rule'}</button></li>)}</ul>:<p className="ob-hint">{zh?'没有以前留下的发送规则。':'No earlier send rules are stored.'}</p>}
    {error?<p role="alert">{error}</p>:null}
  </section>
}
