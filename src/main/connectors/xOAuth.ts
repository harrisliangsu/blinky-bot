/** Native OAuth PKCE for a user-owned X public client; never logs credentials. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { assertXStorageAvailable, clearXCredentials, readXCredentials, saveXCredentials } from './xSecrets'
import { validateXClient, xClientId } from './oauthClients'

export const X_REDIRECT = 'http://127.0.0.1:47839/oauth/x/callback'
const AUTH = 'https://x.com/i/oauth2/authorize', TOKEN = 'https://api.x.com/2/oauth2/token'
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access']
type Fetch = typeof globalThis.fetch
type Open = (url: string) => Promise<void>
let testFetch: Fetch | undefined, testOpen: Open | undefined
let active: AbortController | undefined, generation = 0
let connectDone: Promise<void> | undefined, disconnecting: Promise<void> | undefined
let cached: { token: string; until: number } | undefined, refreshing: { generation: number; promise: Promise<string> } | undefined
const requests = new Set<AbortController>()
export function setXTransportForTests(fetcher?: Fetch, opener?: Open): void { testFetch = fetcher; testOpen = opener }
function fetcher(): Fetch { return testFetch ?? globalThis.fetch }
async function openAuth(url: string): Promise<void> {
  if (testOpen) return testOpen(url)
  const electron = createRequire(import.meta.url)('electron') as { shell?: { openExternal(url: string): Promise<void> } } | string
  if (typeof electron !== 'object' || !electron.shell) throw new Error('The system browser is unavailable.')
  await electron.shell.openExternal(url)
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('X authorization or API verification failed.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 1_000_000) throw new Error('X returned an oversized response.'); chunks.push(part.value) } } finally { reader.releaseLock() }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) } catch { throw new Error('X returned an invalid response.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('X returned an invalid response.')
  return value as Record<string, unknown>
}
async function postToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  return json(await fetcher()(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, redirect: 'error', signal: AbortSignal.timeout(15_000) }))
}
async function identity(token: string): Promise<{ userId: string; username: string }> {
  const result = await json(await fetcher()('https://api.x.com/2/users/me', { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }))
  const data = result.data as Record<string, unknown> | undefined
  if (!data || typeof data.id !== 'string' || !/^\d{1,32}$/.test(data.id) || typeof data.username !== 'string' || !/^[A-Za-z0-9_]{1,30}$/.test(data.username)) throw new Error('X did not confirm the authorized account.')
  return { userId: data.id, username: data.username }
}
function sameState(expected: string, actual: string): boolean { const a = Buffer.from(expected), b = Buffer.from(actual); return a.length === b.length && timingSafeEqual(a, b) }
export function invalidateXAccess(): void { generation++; cached = undefined; for (const request of requests) request.abort() }
export function cancelXConnect(): void { active?.abort() }
export async function hasXClient(): Promise<boolean> { return !!((await readXCredentials())?.clientId || xClientId()) }
export function disconnectX(): Promise<void> {
  if (disconnecting) return disconnecting
  const connecting = connectDone, refresh = refreshing?.promise
  cancelXConnect(); invalidateXAccess()
  disconnecting = (async () => {
    await connecting
    await refresh?.catch(() => undefined)
    invalidateXAccess()
    await clearXCredentials()
  })().finally(() => { disconnecting = undefined })
  return disconnecting
}

/** Fixed loopback address must be listed exactly in the user's X developer application. */
export async function connectX(clientInput = ''): Promise<{ username: string }> {
  if (active || disconnecting) throw new Error('An X authorization change is already in progress.')
  const controller = new AbortController(); active = controller
  let finishConnect!: () => void
  connectDone = new Promise<void>((resolve) => { finishConnect = resolve })
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = createServer(); let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    assertXStorageAvailable(); await readXCredentials()
    const clientId = clientInput.trim() || (await readXCredentials())?.clientId || xClientId()
    if (!clientId) throw new Error('This distribution needs an X Native App client before browser sign-in is available.')
    validateXClient(clientId)
    if (controller.signal.aborted) throw new Error('X authorization was cancelled.')
    const codePromise = new Promise<string>((resolve, reject) => {
      let done = false
      const finish = (error?: Error, code?: string): void => { if (done) return; done = true; if (timeout) clearTimeout(timeout); error ? reject(error) : resolve(code!) }
      controller.signal.addEventListener('abort', () => finish(new Error('X authorization was cancelled.')), { once: true })
      timeout = setTimeout(() => finish(new Error('X authorization timed out.')), 5 * 60_000)
      server.on('error', () => finish(new Error('The local authorization listener failed.')))
      server.on('request', (req, res) => {
        if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:47839') { res.writeHead(400).end(); return }
        let url: URL; try { url = new URL(req.url ?? '/', X_REDIRECT) } catch { res.writeHead(400).end(); return }
        if (url.pathname !== '/oauth/x/callback' || url.searchParams.getAll('state').length !== 1 || !sameState(state, url.searchParams.get('state') ?? '')) { res.writeHead(400).end(); return }
        const code = url.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Authorization response received. You may return to BlinkyBot.')
        if (url.searchParams.has('error') || !code || url.searchParams.getAll('code').length !== 1 || code.length > 4096) finish(new Error('X authorization was declined or invalid.'))
        else finish(undefined, code)
      })
    })
    void codePromise.catch(() => undefined)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(47839, '127.0.0.1', resolve) })
    const url = new URL(AUTH)
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: X_REDIRECT, response_type: 'code', scope: SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value)
    if (controller.signal.aborted) throw new Error('X authorization was cancelled.')
    await Promise.race([openAuth(url.toString()), codePromise.then(() => undefined)])
    const code = await codePromise
    if (controller.signal.aborted) throw new Error('X authorization was cancelled.')
    const token = await postToken(new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: X_REDIRECT }))
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || typeof token.scope !== 'string' || !SCOPES.every((scope) => (token.scope as string).split(/\s+/).includes(scope))) throw new Error('X did not grant the required permissions.')
    const user = await identity(token.access_token)
    if (controller.signal.aborted) throw new Error('X authorization was cancelled.')
    invalidateXAccess(); await saveXCredentials({ clientId, refreshToken: token.refresh_token, ...user })
    return { username: user.username }
  } finally { if (timeout) clearTimeout(timeout); controller.abort(); if (server.listening) server.close(); if (active === controller) { active = undefined; connectDone = undefined }; finishConnect() }
}

/** Refresh tokens may rotate: persist the replacement before using its access token. */
export async function xAccessToken(): Promise<string> {
  if (disconnecting) throw new Error('X is disconnecting.')
  if (cached && cached.until > Date.now()) return cached.token
  const current = generation
  if (refreshing?.generation === current) return refreshing.promise
  const operation = (async () => {
    const saved = await readXCredentials()
    if (!saved || generation !== current) throw new Error('X is not connected.')
    const token = await postToken(new URLSearchParams({ client_id: saved.clientId, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }))
    if (generation !== current || typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('X authorization could not be refreshed; reconnect the account.')
    if (token.scope !== undefined && (typeof token.scope !== 'string' || !SCOPES.every((scope) => (token.scope as string).split(/\s+/).includes(scope)))) throw new Error('X no longer grants all required permissions; reconnect the account.')
    await saveXCredentials({ ...saved, refreshToken: token.refresh_token })
    if (generation !== current) throw new Error('X authorization changed during refresh.')
    if (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 60) cached = { token: token.access_token, until: Date.now() + Math.min(token.expires_in - 30, 7200) * 1000 }
    return token.access_token
  })().finally(() => { if (refreshing?.generation === current) refreshing = undefined })
  refreshing = { generation: current, promise: operation }; return operation
}
export async function verifyXConnection(): Promise<{ username: string }> {
  const current = generation, saved = await readXCredentials(); if (!saved) throw new Error('X is not connected.')
  const token = await xAccessToken(), found = await identity(token)
  if (generation !== current || found.userId !== saved.userId) throw new Error('The connected X account changed.')
  return { username: found.username }
}
/** Fetch one public/authorized post. Returned content is untrusted external data. */
export async function readXPost(postId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!/^\d{1,32}$/.test(postId)) throw new Error('Invalid X post id.')
  const current = generation, token = await xAccessToken()
  if (signal?.aborted || current !== generation) throw new Error('X authorization changed or the request was stopped.')
  const controller = new AbortController(); requests.add(controller)
  try {
    const url = new URL(`https://api.x.com/2/tweets/${postId}`)
    url.searchParams.set('tweet.fields', 'author_id,created_at,conversation_id')
    const result = await json(await fetcher()(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) }))
    const data = result.data as Record<string, unknown> | undefined
    if (generation !== current || !data || data.id !== postId || typeof data.text !== 'string') throw new Error('X did not return the requested post.')
    return { id: data.id, text: data.text.slice(0, 50_000), authorId: typeof data.author_id === 'string' ? data.author_id : '', createdAt: typeof data.created_at === 'string' ? data.created_at : '', conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : '', note: 'Media and linked posts are not included.' }
  } finally { requests.delete(controller) }
}
/** Fixed API origin, explicit account binding and no automatic retry. */
export async function postXMessage(expectedUserId: string, text: string, replyToPostId?: string): Promise<string> {
  if (replyToPostId !== undefined && !/^\d{1,32}$/.test(replyToPostId)) throw new Error('Invalid X reply target.')
  const current = generation, saved = await readXCredentials()
  if (!saved || generation !== current || saved.userId !== expectedUserId) throw new Error('The X account for this draft changed.')
  const token = await xAccessToken()
  if (generation !== current) throw new Error('X authorization changed before posting.')
  const controller = new AbortController(); requests.add(controller)
  try {
    const result = await json(await fetcher()('https://api.x.com/2/tweets', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(replyToPostId ? { reply: { in_reply_to_tweet_id: replyToPostId } } : {}) }), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }))
    const data = result.data as Record<string, unknown> | undefined
    if (generation !== current || !data || typeof data.id !== 'string' || !/^\d{1,32}$/.test(data.id)) throw new Error('The X posting result could not be confirmed.')
    return data.id
  } finally { requests.delete(controller) }
}
