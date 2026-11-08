/** Record the lead Bot's assessment separately from the executor's return. */
import type { ToolSchema } from '../../../shared/types'
import { optStrArray, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'review_task',
  description: 'Record your own assessment of a returned independent task after checking the original user objective and available evidence. If work remains and can continue, call delegate_task with continue_task_id instead. complete_claimed records your judgment, not a machine guarantee; blocked is only for a real decision, approval or external blocker.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Returned task id from this conversation.' },
      outcome: { type: 'string', enum: ['complete_claimed', 'blocked'] },
      summary: { type: 'string', description: 'One or two short, plain-language sentences describing the user-relevant outcome or actual blocker/action needed. State material limits honestly. Keep implementation details, commands, hashes and logs in evidence; do not imply the overall goal is complete merely because an Agent returned.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Specific checks and observations supporting this assessment. Required for complete_claimed.' }
    },
    required: ['task_id', 'outcome', 'summary']
  },
  mutating: false
}

export const reviewTaskTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.reviewTask) throw new ToolError('Task review is unavailable in this runtime.')
  const taskId = reqStr(args, 'task_id', 'review_task').trim()
  const outcome = reqStr(args, 'outcome', 'review_task').trim()
  const summary = reqStr(args, 'summary', 'review_task').trim().slice(0, 10000)
  const evidence = (optStrArray(args, 'evidence') ?? []).map((value) => value.trim().slice(0, 2000)).filter(Boolean).slice(0, 20)
  if (outcome !== 'complete_claimed' && outcome !== 'blocked') throw new ToolError('outcome must be complete_claimed or blocked.')
  if (!taskId || !summary) throw new ToolError('A task id and concrete summary are required.')
  if (outcome === 'complete_claimed' && !evidence.length) throw new ToolError('A completion assessment needs specific evidence; continue the task if evidence is missing.')
  const task = await ctx.host.reviewTask(ctx.sessionId, ctx.botId, taskId, outcome, summary, evidence, ctx.signal)
  return { callId: ctx.callId ?? '', name: 'review_task', ok: true, output: `Assessment recorded for task ${task.id}.${task.review?.verifiedFiles?.length ? ' The application checked the listed file conditions; these checks do not prove the entire objective.' : ' This is the lead Bot’s assessment, not independently verified proof.'}`, detail: { taskId: task.id, review: task.review } }
})
