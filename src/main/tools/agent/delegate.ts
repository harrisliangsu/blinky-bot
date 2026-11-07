/** `delegate_task` — start an independently tracked task on a teammate bot. */

import type { AgentTask, Bot, ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'
import type { ToolContext } from '../types'

const NAME = 'delegate_task'

export const schema: ToolSchema = {
  name: NAME,
  description:
    'Start an independent background task. Omit to_bot_id to use this bot’s configured execution agent; ' +
    'otherwise delegate to another bot already in this conversation. Before creating related work, use manage_task list/inspect to decide from context whether an existing executor fits. Send an active executor a message or continue a returned independent task in its original execution session using continue_task_id and the remaining work. Do not reuse a task only because its title looks similar. If the user explicitly named local output files within the workspace, optionally supply output_files for independent existence checks; only supply a SHA-256 if the user gave that exact hash. A file check is only part of verification, never proof of the whole goal.',
  parameters: {
    type: 'object',
    properties: {
      to_bot_id: { type: 'string', description: 'Id or exact name of the teammate bot.' },
      continue_task_id: { type: 'string', description: 'Id of a returned independent task from this conversation to continue in the same execution session.' },
      prompt: { type: 'string', description: 'A self-contained task with the context and expected result.' },
      title: { type: 'string', description: 'Optional short task label.' },
      output_files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path'] }, description: 'Optional explicit user-requested output files within the current workspace; at most 10. Existing files also pass existence-only checks.' },
      plan: { type: 'object', description: 'Think about session reuse and workspace separately. continue_task_id reuses same-task context; independent work gets a new session. Choose priority/dependencies from user goals, urgency and current work. auto isolates independent work and may share a completed dependency; shared requires a task-specific reason. Running tasks are never preempted for priority changes.', properties: {
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, priority_reason: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Existing tasks from this lead/source conversation whose results must be available first.' },
        workspace: { type: 'string', enum: ['auto', 'isolated', 'shared'] }, workspace_reason: { type: 'string' }, session_reason: { type: 'string' }
      } }
    },
    required: ['prompt']
  },
  mutating: true
}

export const delegateTaskTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.delegateTask) throw new ToolError('Background delegation is unavailable in this runtime.')
  const requested = optStr(args, 'to_bot_id')?.trim()
  const target = requested ? resolveTarget(requested, await listBots(ctx)) : resolveTarget(ctx.botId, await listBots(ctx))
  const prompt = reqStr(args, 'prompt', NAME).trim().slice(0, 100_000)
  if (!prompt) throw new ToolError('The delegated task needs a prompt.')
  const title = optStr(args, 'title')?.trim().slice(0, 200)
  const continueTaskId = optStr(args, 'continue_task_id')?.trim()
  const task: AgentTask = await ctx.host.delegateTask(ctx.sessionId, ctx.botId, target.id, prompt, title, continueTaskId, ctx.signal, args.output_files, args.plan as import('../../../shared/taskPlan').TaskPlanInput | undefined)
  return {
    callId: ctx.callId ?? '',
    name: NAME,
    ok: true,
    output: task.sourceSessionId
      ? `${continueTaskId ? 'Continued' : 'Started'} “${task.title}” as an independent background task. Its result will return to this chat. Task ID: ${task.id}${task.acceptance ? '. The application will check the specified files before accepting a completion claim; existence alone does not prove the work is complete.' : ''}`
      : `Started “${task.title}” in the teammate bot’s chat. Check that bot’s chat for its result.`,
    detail: { taskId: task.id, sessionId: task.sessionId, botId: target.id }
  }
})

async function listBots(ctx: ToolContext): Promise<Bot[]> {
  try { return await ctx.host?.listBots?.() ?? [] } catch { return [] }
}

function resolveTarget(requested: string, bots: Bot[]): Bot {
  const target = bots.find((bot) => bot.id === requested) ??
    bots.find((bot) => bot.name.toLocaleLowerCase() === requested.toLocaleLowerCase())
  if (!target || target.archived) throw new ToolError(`There is no active bot “${requested}”.`)
  return target
}
