/**
 * Event fan-out to the renderer.
 *
 * A broadcast must never throw into the loop, and in-process listeners (tests,
 * tooling) see the same stream the window does.
 */

import type { AgentEvent } from '../../shared/types'
import { broadcast as sendToWindows } from '../ipc/broadcast'
import { errorMessage } from './errors'
import { recordLiveMessage } from './liveMessages'
import { createVaultEventProjection } from '../store/vaultEvents'

type Listener = (event: AgentEvent) => void

const listeners = new Set<Listener>()
const projectPrivateOutput = createVaultEventProjection()

export function onAgentEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function broadcast(event: AgentEvent): void {
  for (const safeEvent of projectPrivateOutput(event)) publish(safeEvent)
}

function publish(event: AgentEvent): void {
  recordLiveMessage(event)
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* a bad listener must never break the loop */
    }
  }
  try {
    sendToWindows(event)
  } catch (err) {
    console.warn(`[agent] broadcast failed: ${errorMessage(err)}`)
  }
}

export function broadcastError(sessionId: string, message: string): void {
  broadcast({ type: 'error', sessionId, message })
}
