/** `delegate_task` — start an independently tracked task on a teammate bot. */

import type { AgentTask, Bot, ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'
import type { ToolContext } from '../types'
import { taskContextSchema } from '../../../shared/taskContext'

const NAME = 'delegate_task'

export const schema: ToolSchema = {
  name: NAME,
  description:
    'Start an independent background task. For a new task, include plan.context (summary, categories, scope and boundaries) in the tool arguments; update it when the goal changes. Omit to_bot_id to use this bot’s configured execution agent; ' +
    'otherwise delegate to another bot already in this conversation. First use manage_task match with the new goal, then inspect plausible candidates to decide whether an existing executor fits. Send an active executor a message or continue a returned task using continue_task_id and the remaining work. Check active consumers before continuing a producer. Do not reuse a task only because its title looks similar. If the user explicitly named local output files within the workspace, optionally supply output_files for independent existence checks; only supply a SHA-256 if the user gave that exact hash. A file check is only part of verification, never proof of the whole goal.',
  parameters: {
    type: 'object',
    properties: {
      to_bot_id: { type: 'string', description: 'Id or exact name of the teammate bot.' },
      continue_task_id: { type: 'string', description: 'Id of a returned independent task from this conversation to continue in the same execution session.' },
      prompt: { type: 'string', description: 'A self-contained task with the context and expected result.' },
      title: { type: 'string', description: 'Optional short task label.' },
      output_files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path'] }, description: 'Optional explicit user-requested output files within the current workspace; at most 10. Existing files also pass existence-only checks.' },
      plan: { type: 'object', description: 'Include context for each new task: brief goal, free-form categories, scope and exclusions. A continuation inherits context unless replaced. Think about session reuse and workspace separately. Choose priority/dependencies from user goals, urgency and current work. Running tasks are never preempted for priority changes.', properties: {
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, priority_reason: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Existing tasks from this lead/source conversation whose results must be available first.' },
        workspace: { type: 'string', enum: ['auto', 'isolated', 'shared'], description: 'auto isolates independent work; with one completed prerequisite it can reuse that prerequisite workspace. isolated always allocates a separate workspace. shared uses this lead conversation source directory, NOT a prerequisite task directory; requires a specific reason. A continuation retains its own existing workspace.' }, workspace_reason: { type: 'string' }, session_reason: { type: 'string' },
        context: taskContextSchema
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
  const contextSaved = Boolean(task.plan?.context)
  // Old callers remain valid. Make incomplete new-task metadata visible to
  // the Bot so it can repair the same record rather than silently losing it.
  const contextNotice = task.sourceSessionId && !continueTaskId && !contextSaved
    ? '\nTask context was not saved; only a legacy request excerpt is available for later matching. Complete this same record with manage_task action="describe", task_id="' + task.id + '", context={"summary":"goal and deliverable","categories":["category"],"scope":["work area"],"boundaries":["exclusion"]}. Use the actual goal and boundaries; text is not the context object. This updates metadata only, not execution; do not create another task.'
    : ''
  return {
    callId: ctx.callId ?? '',
    name: NAME,
    ok: true,
    output: task.sourceSessionId
      ? `${continueTaskId ? 'Continued' : 'Started'} “${task.title}” as an independent background task. Its result will return to this chat. Task ID: ${task.id}${task.acceptance ? '. The application will check the specified files before accepting a completion claim; existence alone does not prove the work is complete.' : ''}${contextNotice}`
      : `Started “${task.title}” in the teammate bot’s chat. Check that bot’s chat for its result.`,
    detail: { taskId: task.id, sessionId: task.sessionId, botId: target.id, contextSaved }
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
