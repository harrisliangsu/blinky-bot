/** A common in-process event tap for desktop and approved alternate clients. */
import type { AgentEvent } from '../../shared/types'
const listeners = new Set<(event: AgentEvent) => void>()
export function onDesktopEvent(listener: (event: AgentEvent) => void): () => void { listeners.add(listener); return () => listeners.delete(listener) }
export function publishDesktopEvent(event: AgentEvent): void { for (const listener of listeners) { try { listener(event) } catch { /* an alternate client cannot break the desktop */ } } }
