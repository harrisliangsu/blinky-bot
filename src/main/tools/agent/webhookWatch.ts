import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'create_webhook_routine',
  description: 'Create a local webhook-triggered instruction when the user requests it. The user must open Routines to configure the private credential. Only a signal is accepted; request bodies are ignored. The listener binds to 127.0.0.1, so a remote sender needs a user-managed tunnel, and the Mac must be awake and logged in.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, instruction: { type: 'string' } }, required: ['name', 'instruction'] }, mutating: true
}
export const webhookWatchTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.watchWebhook) throw new ToolError('Webhook routines are unavailable in this runtime.')
  const routine = await ctx.host.watchWebhook(ctx.sessionId, ctx.botId, reqStr(args, 'name', schema.name), reqStr(args, 'instruction', schema.name))
  return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: `Webhook routine ${routine.id} was saved. The user must open Routines and configure its private credential. Its listener is local only, ignores the request body, and requires the Mac to be awake and logged in.`, detail: { routineId: routine.id } }
})
