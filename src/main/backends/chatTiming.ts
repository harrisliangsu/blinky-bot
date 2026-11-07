/** Opt-in diagnostics: stage names and timestamps only, never prompts or secrets. */
export type BackendTimingStage = 'environment-start' | 'environment-ready' | 'process-spawn-start' | 'process-spawned' | 'runtime-ready' | 'thread-ready' | 'warm-reused' | 'model-request' | 'model-request-accepted' | 'first-public-text' | 'first-body-text'
export type TimingObserver = (stage: BackendTimingStage) => void

export function noteTiming(observer: TimingObserver | undefined, stage: BackendTimingStage): void {
  try { observer?.(stage) } catch { /* diagnostics cannot fail a turn */ }
}

export function traceChatTiming(sessionId: string, stage: string, messageId?: string): void {
  if (process.env.BLINKY_CHAT_TIMING !== '1') return
  try { console.log('[blinky-chat-timing] '+JSON.stringify({ at: Date.now(), sessionId, stage, ...(messageId ? { messageId } : {}) })) } catch { /* optional diagnostics */ }
}
