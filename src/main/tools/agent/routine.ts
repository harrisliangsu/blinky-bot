import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'schedule_routine',
  description: 'Create a local recurring instruction when the user asks for one. Cron uses this Mac’s timezone unless tz is explicitly supplied. Optional earlyMinutes/lateMinutes only when the user requests a timing window. The installed macOS app can run routines in the background when enabled and registered; background availability depends on the setting and the user being logged in. Do not claim execution while the Mac is asleep or off.',
  parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Short routine name.' },
    instruction: { type: 'string', description: 'Self-contained work for the Bot to perform at each occurrence.' },
    cron: { type: 'string', description: 'Five cron fields: minute hour day month weekday.' },
    tz: { type: 'string', description: 'Optional IANA timezone; omitted uses the Mac timezone.' },
    earlyMinutes: { type: 'number', description: 'Optional allowed early minutes, explicitly requested by the user.' },
    lateMinutes: { type: 'number', description: 'Optional allowed late minutes, explicitly requested by the user.' }
  }, required: ['name', 'instruction', 'cron'] },
  mutating: true
}

export const scheduleRoutineTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.scheduleRoutine) throw new ToolError('Scheduled instructions are unavailable in this runtime.')
  if ((args.tz !== undefined && typeof args.tz !== 'string') || ['earlyMinutes', 'lateMinutes'].some(key => args[key] !== undefined && typeof args[key] !== 'number')) throw new ToolError('时区或时间偏移参数无效。')
  const routine = await ctx.host.scheduleRoutine(ctx.sessionId, ctx.botId, reqStr(args, 'name', 'schedule_routine'), reqStr(args, 'instruction', 'schedule_routine'), reqStr(args, 'cron', 'schedule_routine'), { tz: args.tz as string | undefined, earlyMinutes: args.earlyMinutes as number | undefined, lateMinutes: args.lateMinutes as number | undefined })
  return { callId: ctx.callId ?? '', name: 'schedule_routine', ok: true, output: `Scheduled “${routine.name}” (${routine.trigger.cron}, ${routine.trigger.tz ?? 'this Mac’s timezone'}). Background execution after closing the window requires the macOS background setting and successful registration; the Mac must be awake and the user logged in. Routine ID: ${routine.id}`, detail: { routineId: routine.id } }
})
