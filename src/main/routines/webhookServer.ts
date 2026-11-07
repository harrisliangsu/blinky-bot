/** Local-only webhook signals. A user-managed tunnel is needed for remote senders. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { app } from 'electron'
import { getRoutine, listRoutines } from '../store/routines'
import { getBot } from '../store/bots'
import { readWebhookSecret } from './webhookSecrets'
import { acceptWebhookSignal } from './webhookInbox'
import { drainWebhookInbox } from './webhookDelivery'
import { postActivity } from '../ipc/broadcast'

export function webhookPort(): number {
  const testPort = process.env.BLINKY_SMOKE === '1' ? Number(process.env.BLINKY_TEST_WEBHOOK_PORT) : 0
  if (Number.isInteger(testPort) && testPort > 1024 && testPort <= 65535) return testPort
  return app.getName() === 'BlinkyBot Preview' ? 47841 : 47840
}
let server: Server | undefined, timer: ReturnType<typeof setInterval> | undefined, active = 0
let status: 'inactive' | 'listening' | 'error' = 'inactive'
const failureNoticeAt = new Map<string, number>()
function reportFailure(key: string, title: string, detail: string, botId: string): void {
  if (Date.now() - (failureNoticeAt.get(key) ?? 0) < 300_000) return
  failureNoticeAt.set(key, Date.now())
  try { postActivity('failed', title, detail, undefined, botId, true) } catch { /* the listener must remain safe if activity storage fails */ }
}
export function webhookStatus(): typeof status { return status }
export function webhookShouldStayAlive(): boolean { return listRoutines().some((r) => r.trigger.kind === 'webhook') }
function fail(response: ServerResponse, code: number): void { response.writeHead(code, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' }); response.end(code === 202 ? 'accepted' : 'request rejected') }
async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (++active > 16) { active--; request.resume(); fail(response, 503); return }
  let authenticated: { id: string; botId: string; name: string } | undefined
  try {
    const match = /^\/webhooks\/([a-f0-9-]{36})$/.exec(request.url ?? '')
    const event = request.headers['x-blinky-event-id'], auth = request.headers.authorization
    if (request.method !== 'POST' || !match || request.headers.origin || request.headers.host !== `127.0.0.1:${webhookPort()}` || typeof event !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(event) || typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) { request.resume(); fail(response, 400); return }
    const routine = getRoutine(match[1]!), bot = routine && getBot(routine.botId)
    if (!routine || routine.trigger.kind !== 'webhook' || !routine.instruction || !bot || bot.archived) { request.resume(); fail(response, 404); return }
    const secret = await readWebhookSecret(routine.id), supplied = Buffer.from(auth.slice(7))
    if (!secret || !timingSafeEqual(Buffer.from(secret), supplied)) { request.resume(); fail(response, 403); return }
    authenticated = { id: routine.id, botId: routine.botId, name: routine.name }
    let length = 0
    for await (const chunk of request) { length += Buffer.byteLength(chunk as Buffer); if (length > 4096) { fail(response, 413); return } }
    // The configuration may change while the request body is arriving.
    const current = getRoutine(routine.id)
    const currentBot = current && getBot(current.botId)
    if (!current || current.trigger.kind !== 'webhook' || current.botId !== routine.botId || !current.instruction || !currentBot || currentBot.archived) { fail(response, 409); return }
    await acceptWebhookSignal(current.id, current.botId, event, current.name, current.instruction)
    fail(response, 202)
    void drainWebhookInbox()
  } catch {
    if (authenticated) reportFailure(`storage:${authenticated.id}`, 'Webhook 接收失败', `例程「${authenticated.name.slice(0, 100)}」的信号接收状态不确定，请检查本机存储；发送方应使用相同事件 ID 重试。`, authenticated.botId)
    if (!response.headersSent) fail(response, 503); else response.end()
  }
  finally { active-- }
}
export function syncWebhookListener(): void {
  if (!webhookShouldStayAlive()) { if (server) { server.close(); server = undefined }; status = 'inactive'; return }
  if (server) return
  const next = createServer((req, res) => { void receive(req, res) })
  next.requestTimeout = 10_000; next.headersTimeout = 10_000; next.maxConnections = 20
  server = next
  next.on('error', () => {
    if (server !== next) return
    server = undefined
    status = 'error'
    for (const routine of listRoutines()) if (routine.trigger.kind === 'webhook') reportFailure(`listener:${routine.id}`, 'Webhook 监听失败', `例程「${routine.name.slice(0, 100)}」无法接收信号，请检查本机监听端口；应用会继续重试。`, routine.botId)
  })
  next.listen(webhookPort(), '127.0.0.1', () => { if (server === next) status = 'listening' })
}
export function installWebhookService(): void { if (timer) return; syncWebhookListener(); timer = setInterval(syncWebhookListener, 5000); timer.unref?.() }
export function stopWebhookService(): void { if (timer) clearInterval(timer); timer = undefined; server?.close(); server = undefined; status = 'inactive' }
