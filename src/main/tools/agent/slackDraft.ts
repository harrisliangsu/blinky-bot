import type { ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = { name:'slack_message_draft',description:'Create a local draft for the connected Slack channel; only the user can confirm sending. For a threaded reply, use the timestamp from the incoming Slack message. Never claim the message was sent until a receipt arrives.',parameters:{type:'object',properties:{text:{type:'string'},thread_ts:{type:'string',description:'Optional Slack message timestamp for a thread reply.'}},required:['text']},mutating:true }
export const slackDraftTool=defineTool(schema,async(args,ctx)=>{
  if(!ctx.host?.createSlackDraft)throw new ToolError('Slack drafts are unavailable.')
  const draft=await ctx.host.createSlackDraft(ctx.sessionId,ctx.botId,{text:reqStr(args,'text',schema.name),threadTs:optStr(args,'thread_ts')})
  return {callId:ctx.callId??'',name:schema.name,ok:true,output:`Slack draft ${draft.id} is ready in the chat for user review. No message has been sent.`,detail:{draftId:draft.id}}
})
