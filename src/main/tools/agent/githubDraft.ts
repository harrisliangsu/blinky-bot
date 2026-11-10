import type { ToolSchema } from '../../../shared/types'
import { reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'

export const schema: ToolSchema = {
  name: 'github_comment_draft',
  description: 'Prepare a GitHub issue or pull request comment for the user to review. This creates a local draft only; it never posts the comment. Do not report it as sent until the user sends it and a receipt is available.',
  parameters: { type: 'object', properties: {
    owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' }, body: { type: 'string' }
  }, required: ['owner', 'repo', 'issue_number', 'body'] },
  mutating: true
}

export const githubCommentDraftTool = defineTool(schema, async (args, ctx) => {
  if (!ctx.host?.createGitHubDraft) throw new ToolError('GitHub drafts are unavailable in this runtime.')
  const number = args.issue_number
  if (typeof number !== 'number') throw new ToolError('issue_number must be a number.')
  const draft = await ctx.host.createGitHubDraft(ctx.sessionId, ctx.botId, { owner: reqStr(args, 'owner', schema.name), repo: reqStr(args, 'repo', schema.name), issueNumber: number, body: reqStr(args, 'body', schema.name) })
  return { callId: ctx.callId ?? '', name: schema.name, ok: true, output: `Draft ${draft.id} is ready in the chat for user review. No comment has been sent.`, detail: { draftId: draft.id } }
})
