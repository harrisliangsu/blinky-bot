import type { ChatRequest } from '../types'
import type { AgentTaskQuestion } from '../../../shared/activity'

type Obj = Record<string, unknown>
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}

/** Kimi's native ACP form bridge. Questions never become operation approvals. */
export async function answerAcpForm(params: Obj, active: () => boolean, requestInput: ChatRequest['requestInput']): Promise<Obj> {
  const cancelled = { action: 'cancel' }
  if (!active() || !requestInput || params.mode !== 'form') return cancelled
  const properties = object(object(params.requestedSchema).properties), keys = Object.keys(properties)
  if (!keys.length || keys.length > 3) return cancelled
  const questions: AgentTaskQuestion[] = [], types = new Map<string, string>()
  for (const key of keys) {
    const field = object(properties[key]), array = field.type === 'array', choice = array ? object(field.items) : field
    if (field.type !== 'string' && !array) return cancelled
    const options = Array.isArray(choice.oneOf) ? choice.oneOf : Array.isArray(choice.anyOf) ? choice.anyOf : []
    const values = options.map(object).flatMap(option => typeof option.const === 'string' ? [{ label: option.const, description: String(option.description ?? '') }] : [])
    if (array && !values.length) return cancelled
    types.set(key, array ? 'array' : 'string')
    questions.push({ id: key, header: String(field.title ?? 'Question'), question: [field.title, field.description, params.message].filter(value => typeof value === 'string' && value.trim()).join('\n'), ...(values.length ? { options: values } : {}), ...(field.writeOnly === true ? { isSecret: true } : {}) })
  }
  try {
    const answers = await requestInput(questions)
    if (!answers || !active()) return cancelled
    const content: Obj = Object.create(null)
    for (const question of questions) {
      const values = answers[question.id]
      if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim() || question.options && !question.options.some(option => option.label === value))) return cancelled
      if (types.get(question.id) === 'string' && values.length !== 1) return cancelled
      content[question.id] = types.get(question.id) === 'array' ? values : values[0]
    }
    return { action: 'accept', content: { ...content } }
  } catch { return cancelled }
}

/** Compatibility bridge for Kimi versions without native form elicitation. */
export async function answerAcpQuestion(params: Obj, active: () => boolean, requestInput: ChatRequest['requestInput']): Promise<Obj> {
  const call = object(params.toolCall), options = Array.isArray(params.options) ? params.options.map(object) : []
  const choices = options.filter(option => option.kind === 'allow_once' && typeof option.name === 'string' && typeof option.optionId === 'string')
  if (!active() || !requestInput || !choices.length) return { outcome: { outcome: 'cancelled' } }
  const text = (Array.isArray(call.content) ? call.content.map(object) : []).map(entry => object(entry.content).text).filter(value => typeof value === 'string').join('\n')
  try {
    const answer = await requestInput([{ id: 'question', header: 'Question', question: text || String(call.title), options: choices.map(option => ({ label: String(option.name), description: '' })) }])
    const selected = answer?.question?.length === 1 ? choices.find(option => option.name === answer.question[0]) : undefined
    return { outcome: selected && active() ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } }
  } catch { return { outcome: { outcome: 'cancelled' } } }
}
