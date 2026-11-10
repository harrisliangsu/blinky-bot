/** Synchronous turn ownership; independent of the ledger and IPC import graph. */
const sessions = new Map<string, number>()

export function routineOwnsNotifications(sessionId: string): boolean {
  return (sessions.get(sessionId) ?? 0) > 0
}

export function manageRoutineNotifications(sessionId: string): () => void {
  sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (sessions.get(sessionId) ?? 1) - 1
    if (count) sessions.set(sessionId, count)
    else sessions.delete(sessionId)
  }
}
