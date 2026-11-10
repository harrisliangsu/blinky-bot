/** GitHub App user OAuth with PKCE and a fixed loopback callback. The client secret is required by GitHub and is not a server secret. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { githubClient, validateGitHubClient } from './oauthClients'
import { assertGitHubStorageAvailable, clearGitHubCredentials, readGitHubCredentials, saveGitHubCredentials, type GitHubCredentials } from './githubSecrets'
import { validGitHubIssueTarget } from './githubTarget'

export const GITHUB_REDIRECT = 'http://127.0.0.1:47841/oauth/github/callback'
export const GITHUB_AUTHORIZE_SCOPE = 'offline_access'
const AUTH = 'https://github.com/login/oauth/authorize'
const TOKEN = 'https://github.com/login/oauth/access_token'
const API = 'https://api.github.com'
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
type Fetch = typeof globalThis.fetch
type Open = (url: string) => Promise<void>
let testFetch: Fetch | undefined, testOpen: Open | undefined
let active: AbortController | undefined, generation = 0
let connectDone: Promise<void> | undefined, disconnecting: Promise<void> | undefined
let cached: { token: string; until: number } | undefined, refreshing: { generation: number; promise: Promise<string> } | undefined
const requests = new Set<AbortController>()
export function setGitHubTransportForTests(fetcher?: Fetch, opener?: Open): void { testFetch = fetcher; testOpen = opener }
function fetcher(): Fetch { return testFetch ?? globalThis.fetch }
async function openAuth(url: string): Promise<void> {
  if (testOpen) return testOpen(url)
  const electron = createRequire(import.meta.url)('electron') as { shell?: { openExternal(url: string): Promise<void> } } | string
  if (typeof electron !== 'object' || !electron.shell) throw new Error('The system browser is unavailable.')
  await electron.shell.openExternal(url)
}
async function readJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('GitHub authorization or API verification failed.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > limit) throw new Error('GitHub returned an oversized response.')
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) } catch { throw new Error('GitHub returned an invalid response.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned an invalid response.')
  return value as Record<string, unknown>
}
function acceptableScope(scope: unknown): boolean {
  if (scope === undefined || scope === '') return true
  if (typeof scope !== 'string') return false
  const parts = scope.split(/[,\s]+/).filter(Boolean)
  return parts.length > 0 && parts.every((part) => part === 'offline_access')
}
async function postToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  const value = await readJson(await fetcher()(TOKEN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'BlinkyBot' }, body: params, redirect: 'error', signal: AbortSignal.timeout(15_000) }), 1_000_000)
  if (typeof value.error === 'string' || !acceptableScope(value.scope)) throw new Error('GitHub did not grant a renewable user authorization.')
  return value
}
function sameState(expected: string, actual: string): boolean {
  const left = Buffer.from(expected), right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}
function remember(access: string, expires: unknown): void {
  if (typeof expires === 'number' && Number.isFinite(expires) && expires > 60) cached = { token: access, until: Date.now() + Math.min(expires - 30, 7200) * 1000 }
}
async function identity(token: string): Promise<string> {
  const controller = new AbortController(); requests.add(controller)
  try {
    const result = await readJson(await fetcher()(`${API}/user`, { headers: githubHeaders(token), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }), 1_000_000)
    if (typeof result.login !== 'string' || !LOGIN.test(result.login)) throw new Error('GitHub did not confirm the authorized account.')
    return result.login
  } finally { requests.delete(controller) }
}
function githubHeaders(token: string, json = false): Record<string, string> {
  return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'BlinkyBot', 'x-github-api-version': '2022-11-28', ...(json ? { 'content-type': 'application/json' } : {}) }
}
export function invalidateGitHubAccess(): void { generation++; cached = undefined; for (const request of requests) request.abort() }
export function cancelGitHubConnect(): void { active?.abort() }
export async function hasGitHubClient(): Promise<boolean> {
  const saved = await readGitHubCredentials()
  return !!(saved?.clientId && saved.clientSecret) || !!githubClient()
}
export async function requireGitHubConnection(): Promise<void> {
  if (disconnecting) throw new Error('GitHub is disconnecting.')
  if (!await readGitHubCredentials()) throw new Error('GitHub is not connected in BlinkyBot. Connect it in Apps. A GitHub CLI login is not used.')
}
export function disconnectGitHub(): Promise<void> {
  if (disconnecting) return disconnecting
  const connecting = connectDone, refresh = refreshing?.promise
  cancelGitHubConnect(); invalidateGitHubAccess()
  disconnecting = (async () => {
    await connecting
    await refresh?.catch(() => undefined)
    invalidateGitHubAccess()
    await clearGitHubCredentials()
  })().finally(() => { disconnecting = undefined })
  return disconnecting
}

/** Fixed loopback URL must be registered on the publisher's GitHub App. Permissions are Issues read/write, not a classic `repo` scope. */
export async function connectGitHub(clientInput = '', secretInput = ''): Promise<{ login: string }> {
  if (active || disconnecting) throw new Error('A GitHub authorization change is already in progress.')
  const controller = new AbortController(); active = controller
  let finishConnect!: () => void
  connectDone = new Promise<void>((resolve) => { finishConnect = resolve })
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = createServer(); let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    assertGitHubStorageAvailable()
    const saved = await readGitHubCredentials()
    const manual = clientInput.trim() !== '' || secretInput.trim() !== ''
    const publisher = manual || saved ? undefined : githubClient()
    const clientId = manual ? clientInput.trim() : saved?.clientId || publisher?.clientId
    const clientSecret = manual ? secretInput.trim() : saved?.clientSecret || publisher?.clientSecret
    if (!clientId || !clientSecret) throw new Error('This distribution needs a GitHub App client before browser sign-in is available.')
    validateGitHubClient(clientId, clientSecret)
    if (controller.signal.aborted) throw new Error('GitHub authorization was cancelled.')
    const codePromise = new Promise<string>((resolve, reject) => {
      let done = false
      const finish = (error?: Error, code?: string): void => { if (done) return; done = true; if (timeout) clearTimeout(timeout); error ? reject(error) : resolve(code!) }
      controller.signal.addEventListener('abort', () => finish(new Error('GitHub authorization was cancelled.')), { once: true })
      timeout = setTimeout(() => finish(new Error('GitHub authorization timed out.')), 5 * 60_000)
      server.on('error', () => finish(new Error('The local authorization listener failed.')))
      server.on('request', (req, res) => {
        if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:47841') { res.writeHead(400).end(); return }
        let url: URL
        try { url = new URL(req.url ?? '/', GITHUB_REDIRECT) } catch { res.writeHead(400).end(); return }
        if (url.pathname !== '/oauth/github/callback' || url.searchParams.getAll('state').length !== 1 || !sameState(state, url.searchParams.get('state') ?? '')) { res.writeHead(400).end(); return }
        const code = url.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end('Authorization response received. You may return to BlinkyBot.')
        if (url.searchParams.has('error') || !code || url.searchParams.getAll('code').length !== 1 || code.length > 4096) finish(new Error('GitHub authorization was declined or invalid.'))
        else finish(undefined, code)
      })
    })
    void codePromise.catch(() => undefined)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(47841, '127.0.0.1', resolve) })
    const url = new URL(AUTH)
    for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: GITHUB_REDIRECT, scope: GITHUB_AUTHORIZE_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value)
    if (url.searchParams.has('client_secret') || controller.signal.aborted) throw new Error('GitHub authorization was cancelled.')
    await Promise.race([openAuth(url.toString()), codePromise.then(() => undefined)])
    const code = await codePromise
    if (controller.signal.aborted) throw new Error('GitHub authorization was cancelled.')
    const token = await postToken(new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: GITHUB_REDIRECT }))
    if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{10,2048}$/.test(token.access_token) || typeof token.refresh_token !== 'string' || !/^[A-Za-z0-9._~+/-]{10,2048}$/.test(token.refresh_token) || (token.token_type !== undefined && String(token.token_type).toLowerCase() !== 'bearer')) throw new Error('GitHub did not grant the required permissions.')
    const login = await identity(token.access_token)
    if (controller.signal.aborted) throw new Error('GitHub authorization was cancelled.')
    invalidateGitHubAccess()
    await saveGitHubCredentials({ clientId, clientSecret, refreshToken: token.refresh_token, login })
    remember(token.access_token, token.expires_in)
    return { login }
  } finally { if (timeout) clearTimeout(timeout); controller.abort(); if (server.listening) server.close(); if (active === controller) { active = undefined; connectDone = undefined }; finishConnect() }
}

/** Refresh tokens rotate. Persist the replacement before using the new access token. */
export async function githubAccessToken(): Promise<string> {
  if (disconnecting) throw new Error('GitHub is disconnecting.')
  if (cached && cached.until > Date.now()) return cached.token
  const current = generation
  if (refreshing?.generation === current) return refreshing.promise
  const operation = (async () => {
    const saved = await readGitHubCredentials()
    if (!saved || generation !== current) throw new Error('GitHub is not connected.')
    const token = await postToken(new URLSearchParams({ client_id: saved.clientId, client_secret: saved.clientSecret, grant_type: 'refresh_token', refresh_token: saved.refreshToken }))
    if (generation !== current || typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{10,2048}$/.test(token.access_token) || typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('GitHub authorization could not be refreshed; reconnect the account.')
    await saveGitHubCredentials({ ...saved, refreshToken: token.refresh_token })
    if (generation !== current) throw new Error('GitHub authorization changed during refresh.')
    remember(token.access_token, token.expires_in)
    return token.access_token
  })().finally(() => { if (refreshing?.generation === current) refreshing = undefined })
  refreshing = { generation: current, promise: operation }
  return operation
}
export async function verifyGitHubConnection(): Promise<{ login: string }> {
  const current = generation, saved = await readGitHubCredentials()
  if (!saved) throw new Error('GitHub is not connected.')
  const login = await identity(await githubAccessToken())
  if (generation !== current || login !== saved.login) throw new Error('The connected GitHub account changed.')
  return { login }
}
async function githubCall(path: string, token: string, limit: number, timeout: number, init?: RequestInit): Promise<Record<string, unknown>> {
  const current = generation, controller = new AbortController(); requests.add(controller)
  try {
    if (current !== generation) throw new Error('GitHub authorization changed or the request was stopped.')
    return await readJson(await fetcher()(`${API}${path}`, { ...init, headers: { ...githubHeaders(token, !!init?.body), ...(init?.headers ?? {}) }, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) }), limit)
  } finally { requests.delete(controller) }
}
export async function readGitHubIssue(owner: string, repo: string, number: number): Promise<Record<string, unknown>> {
  if (!validGitHubIssueTarget(owner, repo, number)) throw new Error('Invalid GitHub issue target.')
  await requireGitHubConnection()
  const issue = await githubCall(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, await githubAccessToken(), 2_000_000, 15_000)
  const expected = `${API}/repos/${owner}/${repo}/issues/${number}`.toLowerCase()
  if (issue.number !== number || typeof issue.url !== 'string' || issue.url.toLowerCase() !== expected || typeof issue.updated_at !== 'string' || !Number.isFinite(Date.parse(issue.updated_at))) throw new Error('GitHub returned a different or invalid issue.')
  return issue
}
/** Issue and pull conversation comments only. Review comments, merges, and code writes are not called. */
export async function postGitHubIssueComment(owner: string, repo: string, number: number, body: string): Promise<string> {
  if (!validGitHubIssueTarget(owner, repo, number) || !body || body.length > 60000) throw new Error('A valid GitHub issue comment is required.')
  await requireGitHubConnection()
  const response = await githubCall(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, await githubAccessToken(), 1_000_000, 30_000, { method: 'POST', body: JSON.stringify({ body }) })
  const url = new URL(String(response.html_url))
  const prefix = `/${owner}/${repo}/`.toLowerCase()
  const expected = [`${prefix}issues/${number}`, `${prefix}pull/${number}`]
  if (!Number.isSafeInteger(response.id) || url.protocol !== 'https:' || url.hostname !== 'github.com' || !expected.includes(url.pathname.toLowerCase()) || url.hash !== `#issuecomment-${response.id}`) throw new Error('The GitHub comment result could not be confirmed.')
  return url.toString()
}
export type { GitHubCredentials }
