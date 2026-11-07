import { actOnSlackDraft, listSlackDrafts } from '../connectors/slackDrafts'
import { handleEvent } from './handler'

export function registerSlackDraftIpc(): void {
  handleEvent('openbot:slack-drafts:list', async (_event,[sessionId]) => {
    if(typeof sessionId!=='string')return {ok:false,error:'无法读取 Slack 草稿。'}
    try{return {ok:true,drafts:await listSlackDrafts(sessionId)}}catch{return {ok:false,error:'Slack 草稿读取失败。'}}
  },()=>({ok:false,error:'无法读取 Slack 草稿。'}))
  handleEvent('openbot:slack-drafts:act', async (_event,[id,sessionId,action]) => {
    if(typeof id!=='string'||typeof sessionId!=='string'||(action!=='send'&&action!=='cancel'))return {ok:false,error:'无效操作。'}
    try{return {ok:true,draft:await actOnSlackDraft(id,sessionId,action)}}catch{return {ok:false,error:'操作未完成，请检查 Slack 连接、账户和草稿状态。'}}
  },()=>({ok:false,error:'操作未完成。'}))
}
