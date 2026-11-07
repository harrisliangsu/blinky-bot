import type { ToolSchema } from '../../../shared/types'
import { optStr, optStrArray, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'calendar_event_draft',
  description: 'Create a local Google Calendar event draft. Optional attendees receive invitations only after the user confirms the draft. Never claim creation or sending without a confirmed receipt.',
  parameters: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 start with timezone offset.' }, end: { type: 'string', description: 'ISO 8601 end with timezone offset.' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' }, description: 'Optional invitee email addresses, at most 50.' } }, required: ['summary', 'start', 'end'] },
  mutating: true
}
export const calendarDraftTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.createCalendarDraft) throw new ToolError('Calendar drafts are unavailable.')
  const draft = await ctx.host.createCalendarDraft(ctx.sessionId, ctx.botId, { summary: reqStr(args, 'summary', schema.name), start: reqStr(args, 'start', schema.name), end: reqStr(args, 'end', schema.name), description: optStr(args, 'description') ?? '', attendees: optStrArray(args, 'attendees') })
  return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: `Calendar draft ${draft.id} is ready for review. No event or invitation has been created.`, detail: { draftId: draft.id } }
})
