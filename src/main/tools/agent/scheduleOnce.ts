import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'schedule_once',
  description: 'Create a once-only local instruction when the user asks for a future task. Save an absolute epoch-millisecond time; default execution window is its minute. An explicitly requested lateMinutes extends the window. Missed or interrupted occurrences never replay automatically. The Mac must be awake and background execution must be enabled.',
  parameters: { type: 'object', properties: {
    name: { type: 'string' }, instruction: { type: 'string' },
    at: { type: 'number', description: 'Absolute Unix epoch milliseconds, with the user timezone already applied.' },
    lateMinutes: { type: 'number', description: 'Optional additional late minutes explicitly requested by the user; default 0.' }
  }, required: ['name', 'instruction', 'at'] }, mutating: true
}
export const scheduleOnceTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.scheduleOnceRoutine) throw new ToolError('一次性例程在此运行方式不可用。')
  if (typeof args.at !== 'number' || (args.lateMinutes !== undefined && typeof args.lateMinutes !== 'number')) throw new ToolError('需要有效的时间点和分钟数。')
  const routine = await ctx.host.scheduleOnceRoutine(ctx.sessionId, ctx.botId, reqStr(args, 'name', 'schedule_once'), reqStr(args, 'instruction', 'schedule_once'), args.at, args.lateMinutes as number | undefined)
  return { callId: ctx.callId ?? '', name: 'schedule_once', ok: true, output: `已保存一次性例程“${routine.name}”，计划时间 ${new Date(routine.trigger.at!).toISOString()}。错过窗口会记录为已错过，不自动补跑。`, detail: { routineId: routine.id, at: routine.trigger.at } }
})
