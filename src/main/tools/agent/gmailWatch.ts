import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'watch_gmail_query',
  description: 'Watch the connected Gmail account for changes among up to 100 messages matching a Gmail search query. The first successful check establishes a silent baseline; later changes trigger the instruction. Polling can miss intermediate changes, and the Mac must be awake and logged in. Do not claim every message will be detected.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, instruction: { type: 'string' }, query: { type: 'string', description: 'Gmail search syntax, e.g. from:example@example.com is:inbox.' }, account_id: { type: 'string', description: 'Optional ID from list_google_accounts. Omit to keep the original default account.' } }, required: ['name', 'instruction', 'query'] }, mutating: true
}
export const watchGmailTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.watchGmail) throw new ToolError('Gmail watches are unavailable in this runtime.')
  const routine = await ctx.host.watchGmail(ctx.sessionId, ctx.botId, reqStr(args, 'name', schema.name), reqStr(args, 'instruction', schema.name), reqStr(args, 'query', schema.name), args.account_id === undefined ? undefined : reqStr(args, 'account_id', schema.name))
  return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: `Gmail watch ${routine.id} was saved. Its first successful check is a silent baseline; subsequent differences among the first 100 matching messages trigger the instruction. Polling can miss intermediate changes, and background checks require an awake, logged-in Mac.`, detail: { routineId: routine.id } }
})
