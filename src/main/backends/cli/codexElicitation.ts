import { isPlainObject } from '../lenientJson'
import type { AgentTaskQuestion } from '../../../shared/activity'

/** The app gateway still authorizes the actual invocation after this response. */
export function allowCoordinatorGatewayCall(
  params: unknown,
  context: { coordinator: boolean; hasGateway: boolean; active: boolean; threadId: string; turnId?: string }
): boolean {
  const p = isPlainObject(params) ? params : {}
  const meta = isPlainObject(p._meta) ? p._meta : {}
  return context.coordinator && context.hasGateway && context.active &&
    p.threadId === context.threadId && (!context.turnId || p.turnId === context.turnId) &&
    p.serverName === 'openbot' && p.mode === 'form' &&
    meta.codex_approval_kind === 'mcp_tool_call' && typeof meta.tool_name === 'string' && meta.tool_name.length > 0
}

/** Installed app-server schema: {answers:{questionId:{answers:string[]}}}. */
export async function answerCodexUserInput(params: unknown, context: { active: () => boolean; threadId: string; turnId?: string }, requestInput?: (questions: AgentTaskQuestion[]) => Promise<Record<string, string[]> | null>): Promise<{ answers: Record<string, { answers: string[] }> }> {
  const empty = { answers: {} }
  const value = isPlainObject(params) ? params : {}
  if (!requestInput || !context.active() || value.threadId !== context.threadId || !context.turnId || value.turnId !== context.turnId || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 3) return empty
  const questions: AgentTaskQuestion[] = []
  for (const question of value.questions) {
    if (!isPlainObject(question) || typeof question.id !== 'string' || !question.id.trim() || typeof question.header !== 'string' || typeof question.question !== 'string' || !question.question.trim()) return empty
    if (question.options !== undefined && question.options !== null && (!Array.isArray(question.options) || question.options.some(option => !isPlainObject(option) || typeof option.label !== 'string' || typeof option.description !== 'string'))) return empty
    questions.push({ id: question.id, header: question.header, question: question.question, ...(Array.isArray(question.options) ? { options: question.options as AgentTaskQuestion['options'] } : {}), ...(question.isOther === true ? { isOther: true } : {}), ...(question.isSecret === true ? { isSecret: true } : {}) })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length) return empty
  try {
    const answers = await requestInput(questions)
    if (!answers || !context.active()) return empty
    const output: Record<string, { answers: string[] }> = Object.create(null)
    for (const question of questions) {
      const value = answers[question.id]
      if (!Array.isArray(value) || !value.length || value.some(text => typeof text !== 'string' || !text.trim())) return empty
      output[question.id] = { answers: value }
    }
    return { answers: output }
  } catch { return empty }
}
