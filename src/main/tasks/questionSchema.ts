import type { AgentTaskQuestion } from '../../shared/activity'
export function parseTaskQuestions(raw: unknown): AgentTaskQuestion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3) throw new TypeError('Provide one to three clarification questions.')
  const questions = raw.map(value => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160 || typeof value.header !== 'string' || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 6000) throw new TypeError('Invalid clarification question.')
    if (value.options !== undefined && value.options !== null && (!Array.isArray(value.options) || value.options.length > 10 || value.options.some((option: Record<string, unknown>) => !option || typeof option.label !== 'string' || !option.label.trim() || typeof option.description !== 'string'))) throw new TypeError('Invalid clarification choices.')
    if (value.kind !== undefined && !['fact', 'implementation', 'preference', 'authorization'].includes(value.kind)) throw new TypeError('Invalid question kind.')
    return { ...(value.kind ? { kind: value.kind } : {}), id: value.id, header: value.header.slice(0, 120), question: value.question, ...(value.options?.length ? { options: value.options.map((option: { label: string; description: string }) => ({ label: option.label.slice(0, 1000), description: option.description.slice(0, 2000) })) } : {}), ...(value.isOther === true ? { isOther: true } : {}), ...(value.isSecret === true ? { isSecret: true } : {}) }
  })
  if (new Set(questions.map(value => value.id)).size !== questions.length) throw new TypeError('Clarification ids must be unique.')
  return questions
}
