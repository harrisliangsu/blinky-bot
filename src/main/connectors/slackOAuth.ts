/** Slack public-client PKCE, user scopes only. No server secret or Socket Mode token. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { slackClientId } from './oauthClients'
import { assertSlackStorageAvailable, readSlackCredentials, saveSlackCredentials, type SlackCredentials } from './slackSecrets'

export const SLACK_REDIRECT = 'http://localhost:47840/oauth/slack/callback'
export const SLACK_USER_SCOPES = ['chat:write', 'channels:read', 'groups:read', 'im:read', 'mpim:read']
type Fetch = typeof globalThis.fetch
type Verify = (token: string, channel: string, signal?: AbortSignal) => Promise<{ teamId: string; userId: string }>
let testFetch: Fetch | undefined, testOpen: ((url: string) => Promise<void>) | undefined
let active: AbortController | undefined, generation = 0
let refreshing: { generation: number; promise: Promise<string> } | undefined
const requests = new Set<AbortController>()
export function setSlackOAuthTransportForTests(fetcher?: Fetch, opener?: (url: string) => Promise<void>): void { testFetch = fetcher; testOpen = opener }
export function invalidateSlackOAuth(): void { generation++; active?.abort(); for (const request of requests) request.abort() }
export function slackBrowserConfigured(): boolean { try { return !!slackClientId() } catch { return false } }

async function tokenRequest(params: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController(); requests.add(controller)
  try {
    const response = await (testFetch ?? globalThis.fetch)('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) })
    if (!response.ok || !response.body) throw new Error('Slack authorization could not be reached.')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_000_000) throw new Error('Slack authorization response is too large.'); chunks.push(part.value) } } finally { reader.releaseLock() }
    const value: unknown = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).ok !== true) throw new Error('Slack authorization was not granted. Check app approval and permissions.')
    return value as Record<string, unknown>
  } finally { requests.delete(controller) }
}
function userToken(value: Record<string, unknown>, previous?: NonNullable<SlackCredentials['oauth']>): { token: string; oauth: NonNullable<SlackCredentials['oauth']> } {
  const scopes = typeof value.scope === 'string' ? value.scope.split(',').filter(Boolean) : previous?.scopes ?? []
  if (value.token_type !== 'user' || typeof value.access_token !== 'string' || !/^(?:xoxp-|xoxe\.xoxp-)[A-Za-z0-9-]{4,8192}$/.test(value.access_token) || !SLACK_USER_SCOPES.every((s) => scopes.includes(s))) throw new Error('Slack did not grant the required user permissions.')
  const expires = value.expires_in
  const refresh = value.refresh_token
  if (refresh !== undefined && (typeof refresh !== 'string' || !refresh || refresh.length > 8192)) throw new Error('Slack returned invalid refresh credentials.')
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 60 || typeof refresh !== 'string')) throw new Error('Slack did not return renewable user credentials.')
  return { token: value.access_token, oauth: { clientId: previous?.clientId ?? '', scopes, ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}), ...(typeof expires === 'number' ? { expiresAt: Date.now() + expires * 1000 } : {}) } }
}
async function open(url: string): Promise<void> {
  if (testOpen) return testOpen(url)
  const e = createRequire(import.meta.url)('electron') as { shell?: { openExternal(url: string): Promise<void> } } | string
  if (typeof e !== 'object' || !e.shell) throw new Error('The system browser is unavailable.')
  await e.shell.openExternal(url)
}

export async function connectSlackBrowser(channelId: string, botId: string, verify: Verify): Promise<SlackCredentials> {
  if (active) throw new Error('Slack authorization is already in progress.')
  const controller = new AbortController(); active = controller
  const run = ++generation, server = createServer(), state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    assertSlackStorageAvailable()
    const saved = await readSlackCredentials(), clientId = saved?.oauth?.clientId ?? slackClientId()
    if (!clientId) throw new Error('This distribution needs a registered Slack public client before browser authorization is available.')
    if (controller.signal.aborted) throw new Error('Slack authorization was cancelled.')
    const codePromise = new Promise<string>((resolve, reject) => {
      let done = false
      const finish = (error?: Error, code?: string): void => { if (done) return; done = true; if (timer) clearTimeout(timer); error ? reject(error) : resolve(code!) }
      controller.signal.addEventListener('abort', () => finish(new Error('Slack authorization was cancelled.')), { once: true })
      timer = setTimeout(() => finish(new Error('Slack authorization timed out.')), 5 * 60_000)
      server.on('error', () => finish(new Error('Slack callback listener could not be opened.')))
      server.on('request', (req, res) => {
        if (req.method !== 'GET' || req.headers.host !== 'localhost:47840') { res.writeHead(400).end(); return }
        let url: URL
        try { url = new URL(req.url ?? '/', SLACK_REDIRECT) } catch { res.writeHead(400).end(); return }
        const actual = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state)
        if (url.pathname !== '/oauth/slack/callback' || actual.length !== expected.length || !timingSafeEqual(actual, expected) || url.searchParams.getAll('state').length !== 1) { res.writeHead(400).end(); return }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Authorization response received. Return to BlinkyBot.')
        const code = url.searchParams.get('code')
        if (url.searchParams.has('error') || !code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) finish(new Error('Slack authorization was declined.'))
        else finish(undefined, code)
      })
    })
    void codePromise.catch(() => undefined)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(47840, 'localhost', resolve) })
    const url = new URL('https://slack.com/oauth/v2/authorize')
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: SLACK_REDIRECT, scope: '', user_scope: SLACK_USER_SCOPES.join(','), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value)
    if (controller.signal.aborted) throw new Error('Slack authorization was cancelled.')
    await Promise.race([open(url.toString()), codePromise.then(() => undefined)])
    const code = await codePromise
    const response = await tokenRequest(new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, redirect_uri: SLACK_REDIRECT }), controller.signal)
    const raw = response.authed_user as Record<string, unknown> | undefined, team = response.team as Record<string, unknown> | undefined
    if (!raw || typeof raw.id !== 'string' || typeof team?.id !== 'string') throw new Error('Slack did not confirm a user and workspace.')
    const grant = userToken(raw), identity = await verify(grant.token, channelId, controller.signal)
    if (identity.userId !== raw.id || identity.teamId !== team.id || controller.signal.aborted || generation !== run) throw new Error('The Slack account changed during authorization.')
    const credentials: SlackCredentials = { appToken: '', botToken: grant.token, botUserId: identity.userId, allowedUserId: identity.userId, teamId: identity.teamId, channelId, botId, oauth: { ...grant.oauth, clientId } }
    await saveSlackCredentials(credentials, () => generation === run && !controller.signal.aborted)
    return credentials
  } finally { if (timer) clearTimeout(timer); controller.abort(); if (server.listening) server.close(); if (active === controller) active = undefined }
}

export async function slackUserAccessToken(): Promise<string> {
  const run = generation, saved = await readSlackCredentials()
  if (!saved?.oauth || generation !== run) throw new Error('Slack browser authorization is not connected.')
  if (!saved.oauth.expiresAt || saved.oauth.expiresAt > Date.now() + 30_000) return saved.botToken
  if (refreshing?.generation === run) return refreshing.promise
  const operation = (async () => {
    if (!saved.oauth!.refreshToken) throw new Error('Reconnect Slack browser authorization.')
    const response = await tokenRequest(new URLSearchParams({ client_id: saved.oauth!.clientId, grant_type: 'refresh_token', refresh_token: saved.oauth!.refreshToken }))
    const grant = userToken(response, saved.oauth)
    if (generation !== run) throw new Error('Slack authorization changed during refresh.')
    await saveSlackCredentials({ ...saved, botToken: grant.token, oauth: grant.oauth }, () => generation === run)
    if (generation !== run) throw new Error('Slack authorization changed during refresh.')
    return grant.token
  })().finally(() => { if (refreshing?.generation === run) refreshing = undefined })
  refreshing = { generation: run, promise: operation }
  return operation
}
