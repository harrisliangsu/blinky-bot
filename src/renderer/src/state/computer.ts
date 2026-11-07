import { coordsOf } from '../lib/format'
import { store } from './core'

const IDLE_AFTER_MS = 6000
const POINTER_TOOLS = new Set(['click', 'double_click', 'drag'])

let idleTimer: number | null = null

function keepAlive(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => store.patch({ computerActive: false }), IDLE_AFTER_MS)
}

/** Records a fresh screen frame and keeps the "using computer" state alive. */
export function noteFrame(screenshot: string): void {
  store.patch({
    computerFrame: {
      screenshot,
      at: Date.now(),
      botId: store.getState().session?.activeBotId ?? null,
      sessionId: store.getState().currentSessionId
    },
    computerActive: true
  })
  keepAlive()
}

/** Captures the click target of a computer-use call for the frame overlay. */
export function notePointer(toolName: string, args: Record<string, unknown>): void {
  if (!POINTER_TOOLS.has(toolName)) return
  const point = coordsOf(args)
  if (!point) return
  store.patch({
    lastClick: {
      ...point,
      at: Date.now(),
      botId: store.getState().session?.activeBotId ?? null
    },
    computerActive: true
  })
  keepAlive()
}
