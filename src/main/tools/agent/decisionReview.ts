import type { ToolSchema } from '../../../shared/types'
import { defineTool, ok } from '../results'
import { decisionReview } from '../../agent/decisionReview'

const schema: ToolSchema = {
  name: 'decision_review', mutating: false,
  description: 'Coordinate an optional development decision review using an actually installed skill. begin discovers skills and deduplicates a concrete issue/evidence; select chooses its contract. Read and execute it through your existing permitted tools, then finish with a brief judgment. No new permissions or user approval are supplied. Missing/failure/timeout/uncertainty means continue independent work, without retrying unchanged inputs.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['begin', 'select', 'finish'] },
    node: { type: 'string', enum: ['development_plan', 'major_conclusion', 'substantial_adjustment'] },
    subject: { type: 'string', description: 'Specific decision, options and constraints.' },
    evidence: { type: 'string', description: 'Necessary concrete evidence, distinguishing facts and unknowns. No credentials or unrelated chats.' },
    review_id: { type: 'string' }, skill_id: { type: 'string' },
    status: { type: 'string', enum: ['reviewed', 'uncertain', 'unreviewed'] },
    summary: { type: 'string', description: 'Brief assessment from actual results, justified corrections or unavailable reason.' }
  }, required: ['action'] }
}
export const decisionReviewTool = defineTool(schema, async (args, ctx) => ok(ctx, schema.name, JSON.stringify(await decisionReview(args, ctx))))
