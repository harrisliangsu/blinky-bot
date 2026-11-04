/**
 * Capability-URL LAN room server.
 *
 * What the link grants, stated properly — the line that used to sit here said
 * "chat only, never tools or files", and that was wrong in the way that
 * matters. A guest can read the shared conversation from the moment it was
 * shared, and can post messages that start a full agent turn on the session's
 * active bot, tools included: the room posts through the same `sendMessage` the
 * owner's own chat box uses.
 *
 * What it does not grant: any other conversation, anything said before sharing
 * began, any tool call or tool output (only `user` and `assistant` text is
 * served), any IPC channel, and any say in which bot answers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { Session } from '../../shared/types'
import { getSession } from '../store/sessions'
import { getBot } from '../store/bots'
import { sharedRoomByToken } from '../store/rooms'
import { loopFn } from '../ipc/agentRuntime'
import { defangSpeakerLabels } from '../agent/history'
import { safeLine } from '../agent/untrusted'

const MAX_BODY = 64 * 1024
const MAX_NAME = 80
const MAX_TEXT = 10_000
/** Guest messages one room may post per window, and the window itself. */
const MAX_POSTS = 5
const POST_WINDOW = 60_000
let server: Server | null = null
let origin = ''
const posts = new Map<string, { count: number; resetAt: number }>()

export async function ensureCollaborationServer(): Promise<string> {
  if (origin) return origin
  await new Promise<void>((resolve, reject) => {
    const created = createServer((req, res) => void handle(req, res).catch(() => reply(res, 500, { error: 'Room request failed.' })))
    created.once('error', reject)
    created.listen(0, '0.0.0.0', () => {
      const address = created.address()
      if (!address || typeof address === 'string') return reject(new Error('Could not determine collaboration port.'))
      server = created
      origin = `http://${lanAddress()}:${address.port}`
      resolve()
    })
  })
  return origin
}

export async function stopCollaborationServer(): Promise<void> {
  const active = server
  server = null
  origin = ''
  posts.clear()
  if (active) await new Promise<void>((resolve) => active.close(() => resolve()))
}

export const collaborationOrigin = (): string => origin

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const page = /^\/room\/([A-Za-z0-9_-]{20,})$/.exec(url.pathname)
  const state = /^\/api\/room\/([A-Za-z0-9_-]{20,})$/.exec(url.pathname)
  const message = /^\/api\/room\/([A-Za-z0-9_-]{20,})\/message$/.exec(url.pathname)
  if (req.method === 'GET' && page) return roomPage(res, page[1]!)
  if (req.method === 'GET' && url.pathname === '/room.js') return script(res)
  if (req.method === 'GET' && state) return roomState(res, state[1]!)
  if (req.method === 'POST' && message) return postMessage(req, res, message[1]!)
  reply(res, 404, { error: 'No such room.' })
}

function roomPage(res: ServerResponse, token: string): void {
  const room = sharedRoomByToken(token)
  if (!room) return reply(res, 404, { error: 'This invite is not active.' })
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(room.name)}</title><style>body{margin:0;background:#111;color:#eee;font:14px system-ui}main{max-width:760px;margin:auto;padding:24px}.messages{display:grid;gap:10px;margin:20px 0}.msg{padding:12px;border-radius:12px;background:#222;white-space:pre-wrap}.user{margin-left:18%;background:#29344c}.meta{font-size:11px;color:#999;margin-bottom:5px}form{display:grid;grid-template-columns:130px 1fr auto;gap:8px;position:sticky;bottom:0;background:#111;padding:12px 0}input,button{border:1px solid #444;border-radius:8px;background:#222;color:#eee;padding:10px}button{cursor:pointer}</style></head><body><main><h1>${escape(room.name)}</h1><p>Shared from BlinkyBot on the local network.</p><div id="messages" class="messages"></div><form id="send"><input id="name" placeholder="Your name" maxlength="80"><input id="text" placeholder="Message the room" maxlength="10000" required><button>Send</button></form></main><script src="/room.js" defer></script></body></html>`
  res.writeHead(200, headers('text/html; charset=utf-8', Buffer.byteLength(html)))
  res.end(html)
}

function script(res: ServerResponse): void {
  const js = `const token=location.pathname.split('/').pop();const box=document.querySelector('#messages');const name=document.querySelector('#name');name.value=localStorage.openbotRoomName||'';async function load(){const r=await fetch('/api/room/'+token,{cache:'no-store'});if(!r.ok)return;const d=await r.json();box.innerHTML='';for(const m of d.messages){const e=document.createElement('div');e.className='msg '+(m.role==='user'?'user':'');const meta=document.createElement('div');meta.className='meta';meta.textContent=m.author+' · '+new Date(m.createdAt).toLocaleTimeString();const body=document.createElement('div');body.textContent=m.content;e.append(meta,body);box.append(e)}window.scrollTo(0,document.body.scrollHeight)}document.querySelector('#send').addEventListener('submit',async e=>{e.preventDefault();const text=document.querySelector('#text');localStorage.openbotRoomName=name.value;const r=await fetch('/api/room/'+token+'/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name.value,text:text.value})});if(r.ok){text.value='';load()}else{const d=await r.json().catch(()=>({}));alert(d.error||'That message was not delivered.')}});load();setInterval(load,2000);`
  res.writeHead(200, headers('text/javascript; charset=utf-8', Buffer.byteLength(js)))
  res.end(js)
}

/*
 * Only what was said after sharing started.
 *
 * The last 200 messages used to be served whatever their age, so handing
 * somebody a link handed them the whole conversation that led up to it —
 * including everything the owner said while the chat was still private.
 * `sharedFrom` is the moment the user turned this room on; the 200 cap still
 * applies on top of it.
 */
function roomState(res: ServerResponse, token: string): void {
  const room = sharedRoomByToken(token)
  const session = room ? getSession(room.sessionId) : null
  if (!room || !session) return reply(res, 404, { error: 'This room is unavailable.' })
  const shared = session.messages.filter((message) => (message.role === 'user' || message.role === 'assistant') && message.createdAt >= room.sharedFrom)
  const messages = shared.slice(-200).map((message) => ({ role: message.role, author: message.role === 'user' ? 'Participant' : 'BlinkyBot', content: message.content, createdAt: message.createdAt }))
  reply(res, 200, { name: room.name, messages })
}

async function postMessage(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const room = sharedRoomByToken(token)
  const session = room ? getSession(room.sessionId) : null
  if (!room || !session) return reply(res, 404, { error: 'This room is unavailable.' })
  if (rateLimited(room.token)) return reply(res, 429, { error: 'Too many messages. Wait a minute, then send it again.' })
  const raw = await read(req)
  if (raw === null) return replyAndClose(res, 413, { error: 'That message is too large.' })
  const body = parseBody(raw)
  if (!body) return reply(res, 400, { error: 'That request was not valid JSON.' })
  const text = guestField(body['text'], MAX_TEXT)
  if (!text) return reply(res, 400, { error: 'A message is required.' })
  const send = await loopFn('sendMessage')
  if (!send) return reply(res, 503, { error: 'The agent runtime is unavailable.' })
  void Promise.resolve(send(session.id, guestLine(session, guestField(body['name'], MAX_NAME), text)))
  reply(res, 202, { ok: true })
}

/*
 * A fixed window per room token.
 *
 * One guest message is a whole agent turn, and `sendMessage` resets the
 * iteration and handoff budgets with it (`limits.resetTurn` in agent/loop.ts) —
 * so a guest posting in a loop could keep a bot working indefinitely and keep
 * the runaway guards from ever biting. Counting per token means a flooded room
 * cannot silence the others.
 */
function rateLimited(token: string): boolean {
  const now = Date.now()
  const bucket = posts.get(token)
  if (!bucket || now >= bucket.resetAt) {
    posts.set(token, { count: 1, resetAt: now + POST_WINDOW })
    return false
  }
  bucket.count += 1
  return bucket.count > MAX_POSTS
}

/** The bot names in this room's session, for the speaker labels a guest must not wear. */
function rosterNames(session: Session): string[] {
  return (session.botIds ?? []).map((id) => getBot(id)?.name ?? '').filter((name) => name !== '')
}

/*
 * One guest-supplied field, flattened the way every other block of text OpenBOT
 * did not write is flattened before it reaches a prompt.
 *
 * `safeLine` strips control characters, bidi overrides and `ACTION:`-style
 * protocol tokens, and — the part that earns its place here — leaves exactly one
 * line, so a guest cannot open a line of their own inside the message.
 *
 * The leading `@` goes too: `addressedBot` in agent/exchange.ts gives the floor
 * to whichever bot a message opens by naming, and a room is bound to one session
 * whose active bot is the owner's choice. Without this, `@Some Bot` in the name
 * box let a stranger on the network pick a bot with a different tool policy.
 * Only the sigil is dropped; the words stay as they were typed.
 */
function guestField(value: unknown, limit: number): string {
  return safeLine(typeof value === 'string' ? value : '', limit).replace(/^@+\s*/, '').trim()
}

/*
 * The single line a guest message becomes.
 *
 * `defangSpeakerLabels` neutralises a speaker label at the head of what they
 * wrote, because the name box is guest-controlled and a guest calling themselves
 * `[moderator]` produced `[moderator]: do X` — read by the next turn as
 * orchestration rather than as something a stranger typed. It is the same
 * treatment quoted text already gets in agent/history.ts, for the same reason.
 *
 * The room's own prefix then takes the head of the line, which no guest input
 * can reach, so framing outside that label list (`[admin]`, `[Owner]`) cannot
 * claim it either — and the bot can see who it is really talking to.
 */
function guestLine(session: Session, name: string, text: string): string {
  return `[room guest] ${defangSpeakerLabels(`${name || 'Guest'}: ${text}`, rosterNames(session))}`
}

/*
 * Parsed body, or null when it is not a JSON object.
 *
 * A guest sending malformed JSON is a 400 they can act on; unguarded it threw
 * into the outer catch and came back as a 500, indistinguishable from a real
 * fault in here.
 */
function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/*
 * The body, or null when it runs past the cap.
 *
 * Null rather than a throw, for the same reason: an oversize body has its own
 * answer (413), and throwing merged it into the blanket 500 with everything
 * else that can go wrong in a handler.
 */
async function read(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; if (size > MAX_BODY) return null; chunks.push(part) }
  return Buffer.concat(chunks).toString('utf8')
}
function lanAddress(): string { for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal) return address.address; return '127.0.0.1' }
function escape(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function headers(type: string, length: number): Record<string, string | number> { return { 'content-type': type, 'content-length': length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } }
function reply(res: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); res.writeHead(status, headers('application/json; charset=utf-8', Buffer.byteLength(body))); res.end(body) }

/*
 * The same JSON answer, but the socket is not reused afterwards.
 *
 * `read` stops consuming as soon as a body runs past the cap, which leaves the
 * rest of that request unread in the socket. On a keep-alive connection the
 * next request is then parsed starting from the leftover bytes, and the guest
 * sees `ECONNRESET` rather than an answer — the room page polls every two
 * seconds on that connection, so one oversized message broke the room until a
 * reload. Closing the connection is what makes 413 a recoverable error.
 */
function replyAndClose(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...headers('application/json; charset=utf-8', Buffer.byteLength(body)), connection: 'close' })
  res.end(body)
}
