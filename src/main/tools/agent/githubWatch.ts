import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'watch_github_issue',
  description: 'Watch a GitHub issue or pull request for changes. The first successful check establishes a baseline without a notification; later changes trigger the instruction. This polls, so it does not guarantee delivery of every individual event. The installed macOS app can check in the background when enabled and registered; it cannot run while the Mac sleeps or is off.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, instruction: { type: 'string' }, owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: ['name', 'instruction', 'owner', 'repo', 'issue_number'] },
  mutating: true
}
export const watchGitHubIssueTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.watchGitHubIssue) throw new ToolError('GitHub watches are unavailable in this runtime.')
  if (typeof args.issue_number !== 'number') throw new ToolError('issue_number must be a number.')
  const routine = await ctx.host.watchGitHubIssue(ctx.sessionId, ctx.botId, reqStr(args, 'name', schema.name), reqStr(args, 'instruction', schema.name), reqStr(args, 'owner', schema.name), reqStr(args, 'repo', schema.name), args.issue_number)
  return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: `GitHub watch ${routine.id} was saved. Its first successful check sets a baseline; subsequent changes trigger the instruction. Background checks after closing the window require the macOS background setting and successful registration; the Mac must be awake and the user logged in.`, detail: { routineId: routine.id } }
})
