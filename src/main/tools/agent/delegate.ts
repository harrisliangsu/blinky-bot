/** `delegate_task` — start an independently tracked task on a teammate bot. */

import type { AgentTask, Bot, ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'
import type { ToolContext } from '../types'
import { taskContextSchema } from '../../../shared/taskContext'

const NAME = 'delegate_task'
const planFields = ['priority', 'priority_reason', 'depends_on', 'workspace', 'workspace_reason', 'session_reason', 'context']

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
      plan: { type: 'object', description: 'Put depends_on, workspace, workspace_reason, priority and context inside this plan object, never at the tool top level. Include context for each new task: brief goal, free-form categories, scope and exclusions. A continuation inherits context unless replaced. Think about session reuse and workspace separately. Choose priority/dependencies from user goals, urgency and current work. Running tasks are never preempted for priority changes.', properties: {
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, priority_reason: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Existing tasks from this lead/source conversation whose results must be available first.' },
        workspace: { type: 'string', enum: ['auto', 'isolated', 'shared'], description: 'Omit for the default shared workspace: the lead conversation source directory (the user’s current directory), no reason needed. auto isolates independent work and with one completed prerequisite can reuse that prerequisite workspace. isolated always allocates a separate workspace. auto/isolated need workspace_reason (user asked, independent git branch, or conflicting active writers on the same files). A continuation retains its own existing workspace.' }, workspace_reason: { type: 'string' }, session_reason: { type: 'string' },
        context: taskContextSchema
      } }
    },
    required: ['prompt']
  },
  mutating: true
}

export const delegateTaskTool = defineTool(schema, async (args, ctx) => {
  const misplaced = planFields.filter(field => Object.hasOwn(args, field))
  if (misplaced.length) throw new ToolError(`Nothing was started or continued. Move these top-level fields inside plan: ${misplaced.join(', ')}. Use {prompt, title, plan:{depends_on:["task-id"], workspace:"auto", context:{summary:"goal", categories:[], scope:[], boundaries:[]}}}; preserve the actual dependencies and context.`)

  if (!ctx.host?.delegateTask) throw new ToolError('Background delegation is unavailable in this runtime.')
  const requested = optStr(args, 'to_bot_id')?.trim()
  const target = requested ? resolveTarget(requested, await listBots(ctx)) : resolveTarget(ctx.botId, await listBots(ctx))
  const prompt = reqStr(args, 'prompt', NAME).trim().slice(0, 100_000)
  if (!prompt) throw new ToolError('The delegated task needs a prompt.')
  const title = optStr(args, 'title')?.trim().slice(0, 200)
  const continueTaskId = optStr(args, 'continue_task_id')?.trim()
  if (process.env['BLINKY_PLAN_GATE'] !== 'off' && !continueTaskId) {
    // Host-side semantic gate: a hollow plan cannot be scheduled or reviewed
    // honestly, so reject before anything is created and let the Bot repair
    // the arguments in the same turn.
    const plan = args.plan && typeof args.plan === 'object' ? args.plan as Record<string, unknown> : undefined
    const context = plan && typeof plan['context'] === 'object' && plan['context'] !== null ? plan['context'] as Record<string, unknown> : undefined
    const summary = typeof context?.['summary'] === 'string' ? context['summary'].trim() : ''
    const scope = Array.isArray(context?.['scope']) ? context['scope'] : []
    const boundaries = Array.isArray(context?.['boundaries']) ? context['boundaries'] : []
    const missing: string[] = []
    if (summary.length < 8) missing.push('context.summary naming the goal and expected result')
    if (!scope.some(item => typeof item === 'string' && item.trim())) missing.push('context.scope listing the concrete modules or paths being changed')
    if (!boundaries.some(item => typeof item === 'string' && item.trim())) missing.push('context.boundaries stating what is excluded')
    if (missing.length) throw new ToolError(`Nothing was started. The plan is too vague to execute and review safely; missing ${missing.join('; ')}. Re-send delegate_task with a complete plan.context.` )
  }
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
