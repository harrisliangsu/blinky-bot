/** Live local grant reductions also apply to an already-streaming model turn. */
const current = new Map<string, ReadonlySet<string>>()
export function recordBotTools(botId: string, tools: readonly string[]): void { current.set(botId, new Set(tools)) }
export function liveBotTools(botId: string, fallback: readonly string[]): string[] {
  const enabled = current.get(botId)
  if (!enabled) return [...fallback]
  return fallback.filter(tool => enabled.has(tool) || (tool === 'manage_task' || tool === 'review_task') && enabled.has('delegate_task'))
}
