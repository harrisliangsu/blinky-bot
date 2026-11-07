import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { resolvePath } from '../paths'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'watch_folder',
  description: 'Create a local folder-change instruction only when the user requests ongoing observation. Recursively compares names and filesystem metadata; never reads file contents or follows child symlinks. The initial snapshot is a silent baseline. Polling can miss changes between checks; unreadable or oversized scans report errors. Requires local computer and the user\'s directory restrictions remain effective.',
  parameters: { type: 'object', properties: {
    name: { type: 'string' }, instruction: { type: 'string' }, path: { type: 'string', description: 'Folder to observe, relative to the working directory or absolute.' }
  }, required: ['name', 'instruction', 'path'] }, mutating: true
}
export const watchFolderTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.watchFolderRoutine) throw new ToolError('文件夹例程在此运行方式不可用。')
  if (ctx.computerTarget?.kind && ctx.computerTarget.kind !== 'local') throw new ToolError('文件夹观察仅支持本机。')
  const path = await resolvePath(ctx, reqStr(args, 'path', 'watch_folder'), { tool: 'watch_folder', mode: 'read' })
  const routine = await ctx.host.watchFolderRoutine(ctx.sessionId, ctx.botId, reqStr(args, 'name', 'watch_folder'), reqStr(args, 'instruction', 'watch_folder'), path)
  return { callId: ctx.callId ?? '', name: 'watch_folder', ok: true, output: `已保存“${routine.name}”，递归观察 ${routine.trigger.path} 的元数据变化。已建立静默基线；未读取文件内容。`, detail: { routineId: routine.id } }
})
