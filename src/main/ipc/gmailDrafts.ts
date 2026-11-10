import { actOnGmailDraft, listGmailDrafts } from '../connectors/gmailDrafts'
import { handleEvent } from './handler'
import { listSendRules, removeSendRule } from '../connectors/sendRules'
import { getSession } from '../store/sessions'
import { getBot } from '../store/bots'

/** Only the trusted application window can send or cancel a local mail draft. */
export function registerGmailDraftIpc(): void {
  handleEvent('openbot:gmail-drafts:presented',async(event,[id,sessionId,updatedAt])=>{
    if(typeof id!=='string'||typeof sessionId!=='string'||typeof updatedAt!=='number'||!Number.isFinite(updatedAt))return false
    const {markGmailDraftPresented}=await import('../agent/gmailUserIntent')
    return markGmailDraftPresented(event.sender.id,id,sessionId,updatedAt)
  },()=>false)
  handleEvent('openbot:send-rules:list',async()=>{
    try{return{ok:true,rules:await listSendRules()}}catch{return{ok:false,error:'发送规则读取失败，现有草稿仍需逐条确认。'}}
  },()=>({ok:false,error:'无法读取发送规则。'}))
  // Keep the old channel as an explicit refusal for older windows. No credential or draft read.
  handleEvent('openbot:send-rules:save-gmail-draft', () => ({ ok: false, error: '自动发送规则已停用，请逐次确认邮件草稿。' }), () => ({ ok: false, error: '自动发送规则已停用。' }))
  handleEvent('openbot:send-rules:remove',async(_event,[id])=>{
    if(typeof id!=='string'||!id)return{ok:false,error:'无效规则。'}
    try{await removeSendRule(id);return{ok:true}}catch{return{ok:false,error:'规则未能撤销，请重试。'}}
  },()=>({ok:false,error:'无法撤销发送规则。'}))
  handleEvent('openbot:gmail-drafts:list', async (_event, [sessionId]) => {
    if (typeof sessionId !== 'string') return { ok: false, error: '无法读取邮件草稿。' }
    try { return { ok: true, drafts: await listGmailDrafts(sessionId) } } catch { return { ok: false, error: '邮件草稿读取失败，请检查本地数据。' } }
  }, () => ({ ok: false, error: '无法读取邮件草稿。' }))
  handleEvent('openbot:gmail-drafts:act', async (_event, [id, sessionId, action]) => {
    if (typeof id !== 'string' || typeof sessionId !== 'string' || (action !== 'send' && action !== 'cancel')) return { ok: false, error: '无效操作。' }
    try { return { ok: true, draft: await actOnGmailDraft(id, sessionId, action) } } catch { return { ok: false, error: '操作未完成，请检查 Gmail 连接、账户和草稿状态。' } }
  }, () => ({ ok: false, error: '操作未完成。' }))
}
