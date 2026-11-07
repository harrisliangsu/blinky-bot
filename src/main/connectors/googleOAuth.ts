/** Google desktop OAuth with PKCE and a loopback callback; credentials remain in the main process. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { addGoogleCredentials, assertGoogleSecretStorageAvailable, googleAccountId, listGoogleAccounts, readGoogleCredentials, removeGoogleCredentials, saveGoogleCredentials, type GoogleCredentials, type GoogleService } from './googleSecrets'
import { googleClient, validateGoogleClient, type GoogleClient } from './oauthClients'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPES: Record<GoogleService, string[]> = {
  gmail: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events']
}
const TIMEOUT_MS = 5 * 60_000
type Fetch = typeof globalThis.fetch
type Open = (url: string) => Promise<void>
let testFetch: Fetch | undefined, testOpen: Open | undefined
let active: AbortController | undefined
let activeService: GoogleService | undefined, activeAccountId: string | undefined, activeUsesDefault = false, connectDone: Promise<void> | undefined
const disconnects = new Map<string, Promise<void>>()
const selectorDisconnects = new Map<string, Promise<void>>()
const refreshes = new Map<string, { generation: string; promise: Promise<string> }>()
const generations = new Map<string, number>(), serviceGenerations = new Map<GoogleService, number>()
const accessCache = new Map<string, { token: string; until: number }>()
const requests = new Map<string, Set<AbortController>>()
const knownAccountIds = new Map<string, string>()
const keyFor = (service: GoogleService, id: string): string => `${service}:${id}`
const selectorFor = (service: GoogleService, id?: string): string => `${service}:${id ?? 'default'}`
const generationFor = (service: GoogleService, key: string): string => `${serviceGenerations.get(service) ?? 0}:${generations.get(key) ?? 0}`
interface AccountBinding { service: GoogleService; id: string; key: string; generation: string; saved: GoogleCredentials }
async function bindAccount(service: GoogleService, accountId?: string): Promise<AccountBinding> {
  if (selectorDisconnects.has(selectorFor(service, accountId))) throw new Error('Google is disconnecting.')
  const saved = await readGoogleCredentials(service, accountId)
  if (!saved) throw new Error('Google is not connected for this account and service.')
  const id = googleAccountId(saved.account), key = keyFor(service, id)
  knownAccountIds.set(selectorFor(service, accountId), id)
  if (disconnects.has(key) || selectorDisconnects.has(selectorFor(service, accountId))) throw new Error('Google is disconnecting.')
  return { service, id, key, generation: generationFor(service, key), saved }
}
const current = (binding: AccountBinding): boolean => generationFor(binding.service, binding.key) === binding.generation

/** Test seam. No renderer or agent has access to transport overrides. */
export function setGoogleOAuthTransportForTests(fetcher?: Fetch, opener?: Open): void { testFetch = fetcher; testOpen = opener }
function fetcher(): Fetch { return testFetch ?? globalThis.fetch }
async function openAuth(url: string): Promise<void> {
  if (testOpen) return testOpen(url)
  const electron = createRequire(import.meta.url)('electron') as { shell?: { openExternal(url: string): Promise<void> } } | string
  if (typeof electron !== 'object' || !electron.shell) throw new Error('The system browser is unavailable.')
  await electron.shell.openExternal(url)
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('Google authorization or API verification failed.')
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 1_000_000) throw new Error('Google returned an oversized response.'); parts.push(chunk.value) }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(parts.map((part) => Buffer.from(part))).toString('utf8')) } catch { throw new Error('Google returned an invalid response.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Google returned an invalid response.')
  return value as Record<string, unknown>
}
async function postToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  return json(await fetcher()(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, redirect: 'error', signal: AbortSignal.timeout(15_000) }))
}
async function account(token: string): Promise<string> {
  const info = await json(await fetcher()(USERINFO, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }))
  return accountEmail(info)
}
function accountEmail(info: Record<string, unknown>): string {
  if (typeof info.email !== 'string' || !info.email || info.email_verified !== true) throw new Error('Google did not return a verified account.')
  return info.email.slice(0, 320)
}
function serviceEndpoint(service: GoogleService): string {
  return service === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1'
}
async function verifyService(service: GoogleService, token: string): Promise<void> {
  await json(await fetcher()(serviceEndpoint(service), { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }))
}
function includesScopes(service: GoogleService, granted: string[]): boolean {
  return SCOPES[service].every((scope) => granted.includes(scope) || (scope === 'email' && granted.includes('https://www.googleapis.com/auth/userinfo.email')))
}
function matchesState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected), b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}
async function resolveClient(service: GoogleService, accountId?: string): Promise<GoogleClient | undefined> {
  // Sharing a client registration never shares a grant or silently connects the
  // other service. Each service still needs its own consent and API check.
  const other = service === 'gmail' ? 'calendar' : 'gmail'
  const first = (await listGoogleAccounts(service))[0]?.id, otherFirst = (await listGoogleAccounts(other))[0]?.id
  const saved = await readGoogleCredentials(service, accountId) ?? (first ? await readGoogleCredentials(service, first) : null) ?? await readGoogleCredentials(other) ?? (otherFirst ? await readGoogleCredentials(other, otherFirst) : null)
  return saved ? { clientId: saved.clientId, clientSecret: saved.clientSecret } : googleClient()
}
export async function hasGoogleClient(service: GoogleService, accountId?: string): Promise<boolean> { return !!await resolveClient(service, accountId) }
export interface GoogleConnectOptions { addAccount?: boolean; accountId?: string }

/** Only one browser approval at a time. Failed reconnect never overwrites a working grant. */
export async function connectGoogle(service: GoogleService, clientIdInput = '', secretInput = '', options: GoogleConnectOptions = {}): Promise<{ account: string }> {
  if (!Object.hasOwn(SCOPES, service)) throw new Error('Unknown Google service.')
  if (typeof options !== 'object' || !options || (options.addAccount !== undefined && typeof options.addAccount !== 'boolean') || (options.accountId !== undefined && (typeof options.accountId !== 'string' || !/^g_[a-f0-9]{24}$/.test(options.accountId))) || (options.addAccount && options.accountId)) throw new Error('Invalid Google connection target.')
  if (active || selectorDisconnects.has(selectorFor(service, options.accountId))) throw new Error('A Google authorization change is already in progress.')
  const controller = new AbortController(); active = controller
  activeService = service; activeAccountId = options.accountId; activeUsesDefault = !options.addAccount && !options.accountId
  const startingServiceGeneration = serviceGenerations.get(service) ?? 0, startingGenerations = new Map(generations)
  let finishConnect!: () => void
  connectDone = new Promise<void>((resolve) => { finishConnect = resolve })
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = createServer()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    // Fail before opening the browser if the encrypted store cannot be read.
    assertGoogleSecretStorageAvailable()
    const previous = await readGoogleCredentials(service, options.accountId)
    if (options.accountId && !previous) throw new Error('The selected Google account is not connected.')
    if (previous && !options.addAccount) activeAccountId = googleAccountId(previous.account)
    if (activeAccountId && disconnects.has(keyFor(service, activeAccountId))) throw new Error('A Google authorization change is already in progress.')
    const configured = clientIdInput.trim() ? { clientId: clientIdInput.trim(), clientSecret: secretInput.trim() } : await resolveClient(service, options.accountId)
    if (!configured) throw new Error('This distribution needs a Google desktop OAuth client before browser sign-in is available.')
    const clientId = configured.clientId, secret = configured.clientSecret ?? ''
    validateGoogleClient(clientId, secret)
    if (controller.signal.aborted) throw new Error('Google authorization was cancelled.')
    const codePromise = new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, code?: string): void => { if (settled) return; settled = true; if (timeout) clearTimeout(timeout); error ? reject(error) : resolve(code!) }
      controller.signal.addEventListener('abort', () => finish(new Error('Google authorization was cancelled.')), { once: true })
      timeout = setTimeout(() => finish(new Error('Google authorization timed out.')), TIMEOUT_MS)
      server.on('error', () => finish(new Error('The local authorization listener failed.')))
      server.on('request', (req, res) => {
        const port = typeof server.address() === 'object' && server.address() ? (server.address() as { port: number }).port : 0
        if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(400).end(); return }
        let url: URL
        try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`) } catch { res.writeHead(400).end(); return }
        if (url.pathname !== '/oauth/callback' || url.searchParams.getAll('state').length !== 1 || !matchesState(state, url.searchParams.get('state') ?? '')) { res.writeHead(400).end(); return }
        const code = url.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Authorization response received. You may return to BlinkyBot.')
        if (url.searchParams.has('error') || !code || url.searchParams.getAll('code').length !== 1 || code.length > 4096) finish(new Error('Google authorization was declined or invalid.'))
        else finish(undefined, code)
      })
    })
    // Attach immediately so a cancelled listener cannot produce an unhandled rejection.
    void codePromise.catch(() => undefined)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The local authorization listener failed.')
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`
    const url = new URL(AUTH)
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES[service].join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: options.addAccount ? 'consent select_account' : 'consent' })) url.searchParams.set(key, value)
    if (options.accountId && previous) url.searchParams.set('login_hint', previous.account)
    if (controller.signal.aborted) throw new Error('Google authorization was cancelled.')
    // Cancellation and timeout must work even if the system browser stalls.
    await Promise.race([openAuth(url.toString()), codePromise.then(() => undefined)])
    const code = await codePromise
    if (controller.signal.aborted) throw new Error('Google authorization was cancelled.')
    const params = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect })
    if (secret) params.set('client_secret', secret)
    const token = await postToken(params)
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || typeof token.scope !== 'string') throw new Error('Google did not return the requested authorization.')
    const granted = token.scope.split(/\s+/).filter(Boolean)
    if (!includesScopes(service, granted)) throw new Error('Google did not grant all requested permissions.')
    const email = await account(token.access_token)
    await verifyService(service, token.access_token)
    if (controller.signal.aborted) throw new Error('Google authorization was cancelled.')
    const id = googleAccountId(email), key = keyFor(service, id)
    if (options.accountId && options.accountId !== id) throw new Error('The browser authorized a different Google account.')
    if ((serviceGenerations.get(service) ?? 0) !== startingServiceGeneration || (generations.get(key) ?? 0) !== (startingGenerations.get(key) ?? 0) || disconnects.has(key)) throw new Error('Google authorization changed during sign-in.')
    // Invalidate old refreshes before queueing the replacement grant so a late
    // rotating refresh cannot restore the previous account after this save.
    const oldId = previous ? googleAccountId(previous.account) : undefined
    if (oldId && !options.addAccount) invalidateGoogleAccessToken(service, oldId)
    invalidateGoogleAccessToken(service, id)
    const credentials = { clientId, ...(secret ? { clientSecret: secret } : {}), refreshToken: token.refresh_token, scopes: granted, account: email }
    if (options.addAccount) await addGoogleCredentials(service, credentials)
    else await saveGoogleCredentials(service, credentials, options.accountId)
    if (!options.addAccount) knownAccountIds.set(selectorFor(service, options.accountId), id)
    if (oldId && !options.addAccount) invalidateGoogleAccessToken(service, oldId)
    invalidateGoogleAccessToken(service, id)
    if (controller.signal.aborted) throw new Error('Google authorization was cancelled.')
    return { account: email }
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
    if (server.listening) server.close()
    if (active === controller) { active = undefined; activeService = undefined; activeAccountId = undefined; activeUsesDefault = false; connectDone = undefined }
    finishConnect()
  }
}

export function cancelGoogleConnect(): void { active?.abort() }
/** Drain old writes before deletion so a late connect/refresh cannot restore a disconnected grant. */
export function disconnectGoogle(service: GoogleService, accountId?: string): Promise<void> {
  const selector = selectorFor(service, accountId), pending = selectorDisconnects.get(selector)
  if (pending) return pending
  const known = accountId ?? knownAccountIds.get(selector)
  if (known) invalidateGoogleAccessToken(service, known)
  // Cancellation is synchronous: a completed HTTP response in the next
  // microtask must not outrun a disconnect waiting on its disk read.
  if (activeService === service && ((accountId === undefined && activeUsesDefault) || (known && activeAccountId === known))) active?.abort()
  const operation = (async () => {
    const saved = await readGoogleCredentials(service, accountId), id = saved ? googleAccountId(saved.account) : accountId
    const connecting = activeService === service && ((accountId === undefined && activeUsesDefault) || (id && activeAccountId === id)) ? connectDone : undefined
    if (connecting) active?.abort()
    const key = id ? keyFor(service, id) : undefined, sameAccount = key ? disconnects.get(key) : undefined
    if (sameAccount) { await sameAccount; return }
    const removing = (async () => {
      if (id) invalidateGoogleAccessToken(service, id)
      const refreshing = key ? refreshes.get(key)?.promise : undefined
      await connecting; await refreshing?.catch(() => undefined)
      if (id) invalidateGoogleAccessToken(service, id)
      await removeGoogleCredentials(service, accountId)
    })()
    if (key) disconnects.set(key, removing)
    try { await removing } finally { if (key && disconnects.get(key) === removing) disconnects.delete(key) }
  })().finally(() => { selectorDisconnects.delete(selector); knownAccountIds.delete(selector) })
  selectorDisconnects.set(selector, operation)
  return operation
}
export function invalidateGoogleAccessToken(service: GoogleService, accountId?: string): void {
  if (accountId !== undefined) {
    const key = keyFor(service, accountId)
    accessCache.delete(key); generations.set(key, (generations.get(key) ?? 0) + 1)
    for (const request of requests.get(key) ?? []) request.abort()
  } else {
    serviceGenerations.set(service, (serviceGenerations.get(service) ?? 0) + 1)
    for (const key of accessCache.keys()) if (key.startsWith(service + ':')) accessCache.delete(key)
    for (const [key, active] of requests) if (key.startsWith(service + ':')) for (const request of active) request.abort()
  }
}

/** Short-lived access tokens stay in memory and are never returned to the renderer. */
export async function googleAccessToken(service: GoogleService, accountId?: string): Promise<string> { return accessTokenFor(await bindAccount(service, accountId)) }
async function accessTokenFor(binding: AccountBinding): Promise<string> {
  const { service, id, key, generation } = binding
  if (!current(binding) || disconnects.has(key)) throw new Error('Google authorization changed during the request.')
  const cached = accessCache.get(key); if (cached && cached.until > Date.now()) return cached.token
  const running = refreshes.get(key); if (running?.generation === generation) return running.promise
  const operation = (async () => {
    // The account stays bound, but a concurrent/previous refresh may have
    // rotated its credential after this binding was captured. Never re-resolve
    // the default slot, and never refresh with the binding's stale snapshot.
    const saved = await readGoogleCredentials(service, id)
    if (!saved || googleAccountId(saved.account) !== id || !current(binding) || disconnects.has(key)) throw new Error('Google authorization changed during the request.')
    if (!includesScopes(service, saved.scopes)) throw new Error('Google is not connected for this service.')
    const params = new URLSearchParams({ client_id: saved.clientId, refresh_token: saved.refreshToken, grant_type: 'refresh_token' })
    if (saved.clientSecret) params.set('client_secret', saved.clientSecret)
    const token = await postToken(params)
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Google authorization could not be refreshed.')
    if (!current(binding)) throw new Error('Google authorization changed during the request.')
    // A refresh response may omit scope when the grant is unchanged. When it
    // includes scope, use the server's current grant rather than the old file.
    if (token.scope !== undefined && (typeof token.scope !== 'string' || !includesScopes(service, token.scope.split(/\s+/).filter(Boolean)))) throw new Error('Google no longer grants all required permissions; reconnect the account.')
    if (token.refresh_token !== undefined) {
      if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('Google returned invalid refresh credentials.')
      // Persist a replacement before exposing the access token. Disconnect
      // drains this operation before deleting credentials, including this write.
      await saveGoogleCredentials(service, { ...saved, refreshToken: token.refresh_token }, id)
      if (!current(binding)) throw new Error('Google authorization changed during refresh.')
    }
    if (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) && token.expires_in > 60) accessCache.set(key, { token: token.access_token, until: Date.now() + Math.min(token.expires_in - 30, 3600) * 1000 })
    return token.access_token
  })().finally(() => { if (refreshes.get(key)?.generation === generation) refreshes.delete(key) })
  refreshes.set(key, { generation, promise: operation })
  return operation
}

function rejectAccessToken(binding: AccountBinding, token: string): void {
  // Do not touch another account, nor a newer token on this same account.
  if (accessCache.get(binding.key)?.token === token) accessCache.delete(binding.key)
}

/** A bounded GET recovery always uses the original account and generation. */
async function authorizedGet(binding: AccountBinding, url: string | URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController(), active = requests.get(binding.key) ?? new Set<AbortController>()
  active.add(controller); requests.set(binding.key, active)
  const checkCurrent = (): void => {
    if (controller.signal.aborted || signal?.aborted || !current(binding) || disconnects.has(binding.key)) throw new Error('Google authorization changed or the request was stopped.')
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCurrent()
      const token = await accessTokenFor(binding)
      checkCurrent()
      const response = await fetcher()(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) })
      checkCurrent()
      if (response.status === 401) {
        rejectAccessToken(binding, token)
        await response.body?.cancel()
        checkCurrent()
        if (attempt === 0) continue
      }
      const value = await json(response)
      checkCurrent()
      return value
    }
    throw new Error('Google authorization or API verification failed.')
  } finally { active.delete(controller); if (!active.size) requests.delete(binding.key) }
}

/** Fixed Google API origins only. Responses are bounded and tokens stay in this process. */
export async function googleApiGet(service: GoogleService, path: string, query?: Record<string, string>, signal?: AbortSignal, accountId?: string): Promise<Record<string, unknown>> {
  const origin = service === 'gmail' ? 'https://gmail.googleapis.com' : 'https://www.googleapis.com'
  const prefix = service === 'gmail' ? '/gmail/v1/' : '/calendar/v3/'
  if (!path.startsWith(prefix) || path.includes('..') || path.includes('?') || path.includes('#')) throw new Error('Invalid Google API path.')
  const url = new URL(path, origin)
  if (url.origin !== origin || !url.pathname.startsWith(prefix)) throw new Error('Invalid Google API path.')
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  return authorizedGet(await bindAccount(service, accountId), url, signal)
}

/** Called only after a trusted user confirms a local draft. Never retries. */
export class GoogleSendNotStartedError extends Error {
  readonly code = 'google_send_not_started'
  constructor() { super('The request was stopped before Gmail submission.'); this.name = 'GoogleSendNotStartedError' }
}
export async function sendGmailRaw(raw: string, expectedAccount: string, accountId?: string, beforePost?: () => boolean): Promise<string> {
  const binding = await bindAccount('gmail', accountId)
  if (binding.saved.account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('The connected Gmail account changed.')
  const token = await accessTokenFor(binding)
  if (!current(binding)) throw new Error('Google authorization changed before sending.')
  const controller = new AbortController(), active = requests.get(binding.key) ?? new Set<AbortController>()
  active.add(controller); requests.set(binding.key, active)
  try {
    if (beforePost) {
      let allowed = false
      try { allowed = beforePost() !== false } catch { /* A failed final fence cannot submit mail. */ }
      if (!allowed) throw new GoogleSendNotStartedError()
    }
    const response = await fetcher()('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
    if (response.status === 401) rejectAccessToken(binding, token)
    const value = await json(response)
    if (!current(binding) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error('The Gmail send result could not be confirmed.')
    return value.id
  } finally { active.delete(controller); if (!active.size) requests.delete(binding.key) }
}

/** Invoked only from a user-confirmed local event card. Never retries an uncertain write. */
export async function createCalendarEvent(input: { summary: string; start: string; end: string; description: string; attendees?: string[] }, expectedAccount: string, accountId?: string): Promise<string> {
  const binding = await bindAccount('calendar', accountId)
  if (binding.saved.account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('The connected calendar account changed.')
  const token = await accessTokenFor(binding)
  if (!current(binding)) throw new Error('Google authorization changed before creating the event.')
  const controller = new AbortController(), active = requests.get(binding.key) ?? new Set<AbortController>()
  active.add(controller); requests.set(binding.key, active)
  try {
    const attendees = input.attendees ?? []
    const body = { summary: input.summary, description: input.description, start: { dateTime: input.start }, end: { dateTime: input.end }, ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}) }
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${attendees.length ? 'all' : 'none'}`
    const value = await json(await fetcher()(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }))
    if (!current(binding) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value.id)) throw new Error('Calendar event creation could not be confirmed.')
    return value.id
  } finally { active.delete(controller); if (!active.size) requests.delete(binding.key) }
}

/** Verify a saved connection against Google; presence of encrypted data is not enough. */
export async function verifyGoogleConnection(service: GoogleService, accountId?: string): Promise<{ account: string }> {
  const binding = await bindAccount(service, accountId)
  const email = accountEmail(await authorizedGet(binding, USERINFO))
  if (!current(binding) || email.toLowerCase() !== binding.saved.account.toLowerCase()) throw new Error('The authorized Google account changed.')
  await authorizedGet(binding, serviceEndpoint(service))
  if (!current(binding)) throw new Error('Google authorization changed during verification.')
  return { account: email }
}

export function hasGoogleScope(service: GoogleService, credentials: GoogleCredentials): boolean { return includesScopes(service, credentials.scopes) }
