/** Synchronous ownership while a turn or a queue write is being prepared. */
const starting = new Set<string>()
const cancelled = new Set<string>()
const queueWrites = new Map<string, number>()

export function isStarting(sessionId: string): boolean { return starting.has(sessionId) }
export function reserveStart(sessionId: string): void { cancelled.delete(sessionId); starting.add(sessionId) }
export function cancelStart(sessionId: string): void { if (starting.has(sessionId)) cancelled.add(sessionId) }
export function isStartCancelled(sessionId: string): boolean { return cancelled.has(sessionId) }
export function releaseStart(sessionId: string): void { starting.delete(sessionId); cancelled.delete(sessionId) }
export function hasPendingQueueWrite(sessionId: string): boolean { return (queueWrites.get(sessionId) ?? 0) > 0 }
export function beginQueueWrite(sessionId: string): void { queueWrites.set(sessionId, (queueWrites.get(sessionId) ?? 0) + 1) }
export function endQueueWrite(sessionId: string): void {
  const remaining = (queueWrites.get(sessionId) ?? 1) - 1
  if (remaining > 0) queueWrites.set(sessionId, remaining)
  else queueWrites.delete(sessionId)
}
