import type { ToolSchema } from '../../../shared/types'
import { googleAccountStatuses } from '../../apps/status'
import { getBot } from '../../store/bots'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'list_google_accounts',
  description: 'List connected Google account IDs, labels, default selection and verified status for the Google services this Bot is allowed to use. Account IDs may be passed as account_id to the corresponding mail/calendar tools. No credentials are returned.',
  parameters: { type: 'object', properties: { service: { type: 'string', enum: ['gmail','calendar'] } } },
  mutating: false
}
export const googleAccountsTool = defineTool(schema, async (args, ctx) => {
  const bot = getBot(ctx.botId)
  if (!bot || bot.archived) throw new ToolError('This Bot is unavailable.')
  const grants = new Set<string>(bot.tools), explicit = grants.has('list_google_accounts')
  const allowed = (['gmail','calendar'] as const).filter(service => explicit || (service === 'gmail'
    ? ['search_gmail','read_gmail','watch_gmail_query','gmail_draft'].some(name => grants.has(name))
    : ['list_calendar_events','calendar_event_draft'].some(name => grants.has(name))))
  if (args.service !== undefined && args.service !== 'gmail' && args.service !== 'calendar') throw new ToolError('Choose gmail or calendar.')
  if (!allowed.length || (args.service !== undefined && !allowed.includes(args.service as 'gmail'|'calendar'))) throw new ToolError('This Bot has no access to the requested Google service.')
  const services = args.service === undefined ? allowed : [args.service as 'gmail'|'calendar']
  try {
    const accounts = await Promise.all(services.map(async service => ({ service, accounts: await googleAccountStatuses(service) })))
    return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: JSON.stringify(accounts) }
  } catch { throw new ToolError('Google account status could not be verified. Check the app connections.') }
})
