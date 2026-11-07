/** Local Slack Socket Mode client: ack only after an allowed event is durable. */
import { onAgentEvent } from '../agent/events'
import { openSlackSocket, slackAuthorizationProblem, verifySlackConnection } from './slackApi'
import { slackBrowserConfigured } from './slackOAuth'
import { acceptSlackEvent } from './slackInboxStore'
import { drainSlackInbox } from './slackInbox'
import { readSlackCredentials, type SlackCredentials } from './slackSecrets'

export type SlackState = 'disconnected' | 'connecting' | 'connected' | 'error'
let state: SlackState = 'disconnected', socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, generation = 0, attempts = 0, installed = false, loading = false
let config: SlackCredentials | null = null
let browserCheckedAt = 0, browserChecking = false

export function slackConnectionState(): { state: SlackState; teamId?: string; channelId?: string; allowedUserId?: string; botId?: string; mode?: 'browser' | 'socket'; browserReady?: boolean } {
  if (config && slackAuthorizationProblem()) state = 'error'
  if (config?.oauth && !browserChecking && Date.now() - browserCheckedAt > 30_000) {
    const run = generation; browserChecking = true
    void verifySlackConnection().then(() => { if (run === generation) state = 'connected' }).catch(() => { if (run === generation) state = 'error' }).finally(() => { browserCheckedAt = Date.now(); browserChecking = false })
  }
  return { state, browserReady: !!config?.oauth || slackBrowserConfigured(), ...(config ? { mode: config.oauth ? 'browser' : 'socket', teamId: config.teamId, channelId: config.channelId, allowedUserId: config.allowedUserId, botId: config.botId } : {}) }
}
export async function slackConfigured(): Promise<boolean> { try { return !!(await readSlackCredentials()) } catch { return false } }
export function slackShouldStayAlive(): boolean { return loading || (config !== null && !config.oauth) }
export function installSlackSocket(): void {
  if (installed) return
  installed = true
  onAgentEvent((event) => { if (event.type === 'session-updated') void drainSlackInbox() })
  void restartSlackSocket()
}
export async function restartSlackSocket(): Promise<void> {
  const run = ++generation
  if (retry) clearTimeout(retry); retry = undefined
  socket?.close(); socket = undefined; config = null; attempts = 0; loading = true; state = 'connecting'
  let loaded: SlackCredentials | null
  try { loaded = await readSlackCredentials() } catch { if (run === generation) state = 'error'; return } finally { if (run === generation) loading = false }
  if (run !== generation) return
  config = loaded
  if (!config) { state = 'disconnected'; return }
  if (config.oauth) {
    try { await verifySlackConnection(); if (run === generation) state = 'connected' }
    catch { if (run === generation) state = 'error' }
    browserCheckedAt = Date.now()
    return
  }
  void connect(run)
  void drainSlackInbox()
}
export function stopSlackSocket(): void {
  generation++; if (retry) clearTimeout(retry); retry = undefined
  socket?.close(); socket = undefined; config = null; loading = false; state = 'disconnected'
}
function reconnect(run: number): void {
  if (run !== generation || !config || retry) return
  state = 'error'; const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6))
  retry = setTimeout(() => { retry = undefined; void connect(run) }, wait); retry.unref?.()
}
async function connect(run: number): Promise<void> {
  const current = config
  if (!current || run !== generation) return
  state = 'connecting'
  try {
    const url = await openSlackSocket(current.appToken)
    if (run !== generation || config !== current) return
    const ws = new WebSocket(url); socket = ws
    let ready = false
    const helloDeadline = setTimeout(() => { if (!ready) ws.close() }, 15_000); helloDeadline.unref?.()
    ws.addEventListener('message', (event) => {
      if (run !== generation || socket !== ws) return
      let value: unknown; try { if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new Error('invalid'); value = JSON.parse(event.data) } catch { return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const data = value as Record<string, unknown>
      if (data.type === 'hello') { ready = true; clearTimeout(helloDeadline); attempts = 0; state = 'connected'; return }
      if (data.type === 'disconnect') { ws.close(); return }
      if (typeof data.envelope_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.envelope_id)) return
      const envelopeId = data.envelope_id
      void (async () => {
        try {
          if (data.type === 'events_api') await acceptSlackEvent(current, data.payload)
          if (run !== generation || socket !== ws || ws.readyState !== WebSocket.OPEN) return
          ws.send(JSON.stringify({ envelope_id: envelopeId }))
          if (data.type === 'events_api') void drainSlackInbox()
        } catch { console.error('[slack] event was not acknowledged because it could not be saved') }
      })()
    })
    ws.addEventListener('error', () => { clearTimeout(helloDeadline); if (run === generation) state = 'error' })
    ws.addEventListener('close', () => { clearTimeout(helloDeadline); if (socket === ws) socket = undefined; reconnect(run) })
  } catch { reconnect(run) }
}
