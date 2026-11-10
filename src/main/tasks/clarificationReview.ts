/** The result-review turn keeps its original task association through ask_user. */
const reviews = new Map<string, { taskId: string; botId: string }>()
export function clarificationReview(sessionId: string): { taskId: string; botId: string } | undefined { return reviews.get(sessionId) }
export async function withClarificationReview<T>(sessionId: string, taskId: string, botId: string, run: () => Promise<T>): Promise<T> {
  if (reviews.has(sessionId)) throw new Error('A task review already owns this conversation.')
  const value = { taskId, botId }; reviews.set(sessionId, value)
  try { return await run() } finally { if (reviews.get(sessionId) === value) reviews.delete(sessionId) }
}
