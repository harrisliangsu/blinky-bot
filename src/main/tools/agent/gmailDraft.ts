import type { ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'gmail_draft',
  description: 'Prepare one Gmail message as a local review draft. Sending requires explicit user confirmation. Never retry a cancelled or uncertain send or claim recipient delivery from a send receipt.',
  parameters: { type: 'object', properties: { to: { type: 'string', description: 'One recipient email address.' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain-text message.' },account_id:{type:'string',description:'Optional Gmail account ID from list_google_accounts. Omit only to use the default connection.'} }, required: ['to', 'subject', 'body'] },
  mutating: true
}
export const gmailDraftTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.createGmailDraft) throw new ToolError('Gmail drafts are unavailable.')
  const accountId=optStr(args,'account_id')
  const draft = await ctx.host.createGmailDraft(ctx.sessionId, ctx.botId, { to: reqStr(args, 'to', schema.name), subject: reqStr(args, 'subject', schema.name), body: reqStr(args, 'body', schema.name),...(accountId?{accountId}:{}) },ctx.signal)
  const output=draft.status==='sent'?`Gmail accepted the send request for draft ${draft.id}. Recipient delivery is not confirmed.`:draft.status==='uncertain'?`The send result for Gmail draft ${draft.id} is uncertain. Check Gmail Sent; do not retry.`:draft.status==='cancelled'?`Gmail draft ${draft.id} was cancelled. Do not retry it.`:draft.status==='sending'?`Gmail draft ${draft.id} already has a send in progress. Do not submit it again.`:draft.sendNotStarted?`Gmail draft ${draft.id} was stopped before the send request began. No email has been sent. It requires a new confirmation; do not retry automatically.`:`Gmail draft ${draft.id} is ready in the chat for user review. No email has been sent.`
  return { callId: ctx.callId ?? '', name: schema.name, ok: (draft.status==='draft'&&!draft.sendNotStarted)||draft.status==='sent', output, detail: { draftId: draft.id,status:draft.status,...(draft.sendAuthorization?{authorization:draft.sendAuthorization}:{}) } }
})
