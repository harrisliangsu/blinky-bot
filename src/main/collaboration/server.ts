/** An explicitly started LAN capability server. No generic IPC, filesystem,
 * permission-grant or account endpoints are exposed to room participants. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { liveMessages } from '../agent/liveMessages'
import { onDesktopEvent } from '../ipc/eventBus'
import { roomRealtime } from './realtime'
import { workspaceEvents } from './workspaceEvents'
import { remoteContext, remoteRpc, clearRemoteContexts } from './workspaceRpc'
import { remoteUpdates } from './updates'
import { getSession } from '../store/sessions'
import { getBot } from '../store/bots'
import { roomById, sharedRoomByToken, type StoredRoom } from '../store/rooms'
import { defangSpeakerLabels } from '../agent/history'
import { safeLine } from '../agent/untrusted'
import { isRunning } from '../agent/cancel'
import { pendingCount } from '../agent/approval'
import { getMessageQueue } from '../store/messageQueue'
import { listTasks } from '../store/tasks'
import { answerTaskClarification, liveTaskClarificationsForSession } from '../tasks/clarifications'
import { enqueueRoomTurn, resumeRoomQueue, stopRoomTurn } from './runtime'
import { roomHistory, RoomHistoryError } from './history'
import { roomAccess, RoomAccessError } from './access'
import { scrubVaultTextsNow } from '../store/vault'
import { redactSecrets } from '../backends/secretRedaction'

let server: Server | null = null
let origin = ''
let starting: Promise<string> | null = null
let stopEvents: (() => void) | null = null
let hosts = new Set<string>()
const posts = new Map<string, { count: number; until: number }>()
const receipts = new Map<string, { fingerprint: string; result: Promise<{ id: string; duplicate: boolean }> }>()

export function lanAddresses(): string[] {
  const entries = Object.entries(networkInterfaces()).filter(([name]) => !/^(lo|utun|tun|tap|bridge|vmnet|vbox|awdl|llw)/i.test(name))
  entries.sort(([a], [b]) => Number(!/^(en|eth|wlan)/.test(a)) - Number(!/^(en|eth|wlan)/.test(b)))
  return [...new Set(entries.flatMap(([, values]) => (values ?? []).filter(value => value.family === 'IPv4' && !value.internal && !value.address.startsWith('169.254.')).map(value => value.address)))]
}
export async function ensureCollaborationServer(): Promise<string> {
  if (origin) return origin
  if (starting) return starting
  const addresses = lanAddresses()
  if (!addresses.length) throw new Error('No LAN address is available. Connect to Wi-Fi or Ethernet, then share again.')
  starting = new Promise<string>((resolve, reject) => {
    const created = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 503, { error: 'The action could not be confirmed. Please retry.' }); else res.end() }) })
    created.requestTimeout = 15_000; created.headersTimeout = 10_000
    created.once('error', () => { reject(new Error('The local sharing listener could not start.')) })
    created.listen(0, addresses[0], () => {
      const address = created.address()
      if (!address || typeof address === 'string') { created.close(); reject(new Error('No sharing port is available.')); return }
      server = created
      hosts = new Set([addresses[0]!].map(host => `${host}:${address.port}`))
      origin = `http://${addresses[0]}:${address.port}`
      stopEvents = onDesktopEvent(event => {
        const sessionId = event.type === 'session-updated' ? event.session.id : 'sessionId' in event ? event.sessionId : undefined
        const role = sessionId && event.type === 'message-end' ? getSession(sessionId)?.messages.find(message => message.id === event.messageId)?.role : undefined
        roomRealtime.record(event, role); workspaceEvents.record(event)
      })
      resolve(origin)
    })
  })
  try { return await starting } finally { starting = null }
}
export async function stopCollaborationServer(): Promise<void> {
  await starting?.catch(() => {})
  const active = server; server = null; origin = ''; hosts.clear(); posts.clear(); receipts.clear(); roomAccess.clear(); stopEvents?.(); stopEvents = null; roomRealtime.clear(); workspaceEvents.clear(); clearRemoteContexts()
  if (active) await new Promise<void>(resolve => {
    // Let pending polls deliver their 401 after revocation before closing the
    // listener. Killing them immediately looks like ordinary Wi-Fi loss.
    const deadline = setTimeout(() => active.closeAllConnections(), 2000)
    active.close(() => { clearTimeout(deadline); resolve() })
  })
}
export const collaborationOrigin = (): string => origin
export const roomInviteUrl = (room: StoredRoom): string => room.enabled && origin ? `${origin}/room/#${room.token}.${roomAccess.hostKey(room)}` : ''

const allowedQuestion = (question: { kind?: string; isSecret?: boolean }): boolean => question.isSecret !== true && ['fact', 'preference', 'implementation'].includes(question.kind ?? '')
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!server && !starting) return reply(res, 401, { error: 'Sharing was stopped on the Mac.' }, true)
  const host = (req.headers.host ?? '').toLowerCase()
  if (!hosts.has(host)) return reply(res, 421, { error: 'Unrecognized sharing address.' })
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return reply(res, 403, { error: 'Cross-origin requests are not allowed.' })
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (req.method === 'GET' && (path === '/room/' || path === '/room')) return remoteStatic(res, 'remote.html')
  if (req.method === 'GET' && /^\/(?:room\/)?assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg)$/.test(path)) return remoteStatic(res, path.replace(/^\/room\//, '/').slice(1))
  const legacyPage = /^\/room\/([A-Za-z0-9_-]{20,})$/.exec(path)
  if (req.method === 'GET' && legacyPage) {
    if (!sharedRoomByToken(legacyPage[1]!)) return reply(res, 404, { error: 'This invite is inactive.' })
    return remoteStatic(res, 'remote.html')
  }
  if (['/api/connect/challenge', '/api/connect/request', '/api/connect/status'].includes(path)) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed.' })
    const invitation = /^Bearer ([A-Za-z0-9_-]{20,})$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    const pendingRoom = invitation ? sharedRoomByToken(invitation) : null
    if (!pendingRoom) return reply(res, 401, { error: 'This invitation is inactive.' })
    const raw = await read(req)
    if (raw === null) return reply(res, 413, { error: 'Connection request too large.' })
    let body: Record<string, unknown>
    try { body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error() }
    catch { return reply(res, 400, { error: 'Invalid connection request.' }) }
    // Invitation lookup happened before an asynchronous body read: revalidate it.
    const activeRoom = sharedRoomByToken(invitation!)
    if (!activeRoom || activeRoom.id !== pendingRoom.id) return reply(res, 401, { error: 'This invitation is inactive.' })
    try {
      const value = path.endsWith('/challenge') ? roomAccess.challenge(activeRoom, body.publicKey, body.name)
        : path.endsWith('/request') ? roomAccess.request(activeRoom, body.id, body.signature)
          : roomAccess.status(activeRoom, body.id, body.nonce, body.time, body.signature)
      return reply(res, 200, value)
    } catch (error) {
      if (error instanceof RoomAccessError) return reply(res, error.status, { error: error.message })
      throw error
    }
  }
  const route = /^\/api\/room(?:\/([A-Za-z0-9_-]{20,}))?(?:\/(message|stop|resume|answer))?$/.exec(path) ?? (path === '/api/rpc' ? ['', undefined, 'rpc'] : path === '/api/events' ? ['', undefined, 'events'] : null)
  if (!route) return reply(res, 404, { error: 'No such room.' })
  const grant = /^BlinkyDevice ([A-Za-z0-9_-]{40,})$/.exec(String(req.headers.authorization ?? ''))?.[1]
  if (!grant) return reply(res, 401, { error: 'Explicit host approval and a device proof are required.' }, true)
  const raw = req.method === 'POST' ? await read(req, path === '/api/rpc' ? 12 * 1024 * 1024 : 64 * 1024) : ''
  if (raw === null) return reply(res, 413, { error: 'The request is too large.' }, true)
  let access: ReturnType<typeof roomAccess.authorize>
  try { access = roomAccess.authorize(grant, req.headers['x-blinky-nonce'], Number(req.headers['x-blinky-time']), req.headers['x-blinky-signature'], req.method ?? 'GET', url.pathname + url.search, raw, roomById) }
  catch (error) { if (error instanceof RoomAccessError) return reply(res, error.status, { error: error.message }); throw error }
  const { permission, deviceId } = access
  const room = roomById(access.room.id)
  if (!room) return reply(res, 401, { error: 'This device is no longer approved.' })
  const token = room.token
  if (route[1] && route[1] !== token) return reply(res, 404, { error: 'No such room.' })
  const stillApproved = (control = false): boolean => { const current = roomById(room.id); return !!current && roomAccess.stillApproved(deviceId, current, access.grant, control ? 'control' : undefined) }
  if (route[2] === 'rpc' || route[2] === 'events') {
    if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(res, 415, { error: 'JSON is required.' })
    let body: Record<string, unknown>
    try { body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error() }
    catch { return reply(res, 400, { error: 'Invalid application request.' }) }
    const context = remoteContext(access, body.clientId)
    const controller = new AbortController(), close = (): void => controller.abort()
    res.once('close', close)
    try {
      const value = route[2] === 'rpc' ? await remoteRpc(access, context, body, () => stillApproved(permission === 'control')) : await remoteUpdates(access, context, body, () => stillApproved(), controller.signal)
      if (!stillApproved()) return reply(res, 401, { error: 'This device is no longer approved.' })
      return reply(res, 200, value)
    } catch (error) {
      if (error instanceof RoomAccessError || error instanceof RoomHistoryError) return reply(res, error.status, { error: error.message })
      throw error
    } finally { res.removeListener('close', close) }
  }
  const session = getSession(room.sessionId)
  if (!session) return reply(res, 404, { error: 'This conversation is unavailable.' })
  if (req.method === 'GET' && !route[2]) {
    const children = listTasks().filter(task => task.sourceSessionId === session.id && ['running', 'queued'].includes(task.status))
    const queue = getMessageQueue(session.id)
    const questions = liveTaskClarificationsForSession(session.id).filter(request => request.createdAt >= room.sharedFrom)
    let page: ReturnType<typeof roomHistory>
    try { page = roomHistory(roomRealtime.snapshot(session.id, session.messages, liveMessages(session.id)), room, url.searchParams) }
    catch (error) {
      if (error instanceof RoomHistoryError) return reply(res, error.status, { error: error.message })
      throw error
    }
    // One fresh vault snapshot per page. Never send text if secrets cannot be scrubbed.
    const checked = scrubVaultTextsNow(page.messages.map(message => message.content))
    if (checked.unavailable) return reply(res, 503, { error: 'Shared history is temporarily unavailable.' })
    const messages = page.messages.map((message, index) => ({ ...message, content: redactSecrets(checked.texts[index]!) }))
    if (!stillApproved()) return reply(res, 401, { error: 'This device is no longer approved.' })
    return reply(res, 200, { name: room.name, permission, messages, history: page.history, running: isRunning(session.id) || children.length > 0, queued: queue.items.length, paused: queue.paused, interrupted: queue.items.some(item => item.status === 'interrupted'), needsMac: pendingCount(session.id) > 0 || children.some(task => pendingCount(task.sessionId ?? '') > 0) || questions.some(request => request.questions.some(question => !allowedQuestion(question))), questions: permission === 'control' ? questions.filter(request => request.questions.every(allowedQuestion)).map(request => ({ id: request.id, questions: request.questions })) : [] })
  }
  if (req.method !== 'POST' || !route[2]) return reply(res, 405, { error: 'Method not allowed.' })
  if (permission !== 'control') return reply(res, 403, { error: 'This invitation is view-only.' })
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(res, 415, { error: 'JSON is required.' })
  let body: Record<string, unknown>
  try { const value: unknown = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); body = value as Record<string, unknown> } catch { return reply(res, 400, { error: 'Invalid JSON.' }) }
  // Revoke before accepting an in-flight body, including a view-only downgrade.
  if (!stillApproved(true)) return reply(res, 403, { error: 'This invitation no longer permits controls.' })
  switch (route[2]) {
    case 'message': {
      const text = guestField(body.text, 10_000)
      if (!text) return reply(res, 400, { error: 'A message is required.' })
      const requestId = body.requestId === undefined ? randomUUID() : body.requestId
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) return reply(res, 400, { error: 'Invalid message receipt.' })
      const line = guestLine(session.botIds, access.deviceName, text)
      const key = createHash('sha256').update(token + ':' + deviceId + ':' + requestId).digest('hex')
      const fingerprint = createHash('sha256').update(line).digest('hex')
      let receipt = receipts.get(key)
      if (receipt && receipt.fingerprint !== fingerprint) return reply(res, 409, { error: 'That receipt already belongs to another message.' })
      if (!receipt) {
        const now = Date.now(), bucket = posts.get(room.id)
        if (bucket && now < bucket.until && bucket.count >= 5) return reply(res, 429, { error: 'Wait a minute before sending more messages.' })
        posts.set(room.id, { count: bucket && now < bucket.until ? bucket.count + 1 : 1, until: bucket && now < bucket.until ? bucket.until : now + 60_000 })
        if (receipts.size >= 1000) receipts.delete(receipts.keys().next().value!)
        receipt = { fingerprint, result: enqueueRoomTurn(session.id, token + ':' + deviceId, requestId, line, () => stillApproved(true)) }; receipts.set(key, receipt)
      }
      try { return reply(res, 202, { ok: true, receipt: await receipt.result }) }
      catch { receipts.delete(key); return reply(res, 503, { error: 'The message was not confirmed saved. Your text is kept; retry with the same receipt.' }) }
    }
    case 'stop': await stopRoomTurn(session.id); return reply(res, 200, { ok: true })
    case 'resume': await resumeRoomQueue(session.id); return reply(res, 200, { ok: true })
    case 'answer': {
      if (typeof body.id !== 'string') return reply(res, 400, { error: 'A question is required.' })
      const question = liveTaskClarificationsForSession(session.id).find(request => request.id === body.id && request.createdAt >= room.sharedFrom)
      if (!question || !question.questions.every(allowedQuestion)) return reply(res, 403, { error: 'This question must be handled on the Mac.' })
      try { await answerTaskClarification(question.id, body.answers); return reply(res, 200, { ok: true }) }
      catch { return reply(res, 409, { error: 'The answer was not accepted. Check whether the question is still open.' }) }
    }
  }
}
function guestField(value: unknown, limit: number): string { return safeLine(typeof value === 'string' ? value : '', limit).replace(/^@+\s*/, '').trim() }
function guestLine(botIds: string[], name: string, text: string): string {
  return `[room guest] ${defangSpeakerLabels(`${name || 'Guest'}: ${text}`, botIds.map(id => getBot(id)?.name ?? '').filter(Boolean))}`
}
async function read(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string | null> { const chunks: Buffer[] = []; let size = 0; for await (const value of req) { const part = Buffer.from(value); size += part.length; if (size > maxBytes) return null; chunks.push(part) } return Buffer.concat(chunks).toString('utf8') }
function headers(type: string, length: number): Record<string, string | number> { return { 'content-type': type, 'content-length': length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } }
async function remoteStatic(res: ServerResponse, path: string): Promise<void> {
  try {
    const body = await readFile(fileURLToPath(new URL('../renderer/' + path, import.meta.url)))
    const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'font/woff2'
    res.writeHead(200, headers(type + (/(html|javascript|css|svg)/.test(type) ? '; charset=utf-8' : ''), body.length)); res.end(body)
  } catch { reply(res, 404, { error: 'The browser client is unavailable. Rebuild the app.' }) }
}
function reply(res: ServerResponse, status: number, value: unknown, close = false): void { if (res.destroyed || res.writableEnded) return; const body = JSON.stringify(value); res.writeHead(status, { ...headers('application/json; charset=utf-8', Buffer.byteLength(body)), ...(close ? { connection: 'close' } : {}) }); res.end(body) }
