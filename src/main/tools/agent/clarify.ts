/** Structured questions work through both the application loop and the CLI MCP gateway. */
import { defineTool, ok } from '../results'
import { reqStr } from '../args'
import { ToolError } from '../errors'

export const askUserTool = defineTool({
  name: 'ask_user',
  description: 'Ask a necessary clarification using choices and free text. First inspect available context/tools and decide ordinary reversible details yourself. Agent questions go to their owning Bot first; unresolved preference, fact or authorization questions reach the user. Answers return to this exact execution. This is not action approval. Cancelled/expired means no answer: stop the dependent work, do not re-ask unchanged. Reuse request_id for retries; never turn ordinary replies into questions.',
  parameters: { type: 'object', properties: {
    request_id: { type: 'string', description: 'Stable identity for this question; reuse unchanged on transport retry.' },
    questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: {
      id: { type: 'string' }, header: { type: 'string' }, question: { type: 'string' },
      kind: { type: 'string', enum: ['fact', 'implementation', 'preference', 'authorization'] },
      options: { type: 'array', maxItems: 10, items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'description'] } }
    }, required: ['id', 'header', 'question', 'kind'] } }
  }, required: ['request_id', 'questions'] },
  mutating: false
}, async (args, ctx) => {
  if (!ctx.host?.requestInput) throw new ToolError('Interactive clarification is unavailable in this runtime.')
  const requestId = reqStr(args, 'request_id', 'ask_user')
  if (requestId.length > 160) throw new ToolError('request_id is too long.')
  const reply = await ctx.host.requestInput(ctx.sessionId, ctx.botId, args.questions, ctx.signal, `${ctx.messageId ?? ''}:${requestId}`, ctx.clarificationScope)
  return ok(ctx, 'ask_user', JSON.stringify(reply ? { status: 'answered', ...reply, note: 'A Bot decision is not user authorization. Existing action approval gates still apply.' } : { status: 'unanswered', note: 'The question was cancelled, expired, stopped, or could not be saved. Do not guess, re-ask unchanged, or perform the dependent action.' }))
})
