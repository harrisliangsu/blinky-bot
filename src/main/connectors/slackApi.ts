import { getBot } from '../store/bots'
import { assertSlackStorageAvailable, readSlackCredentials, saveSlackCredentials, type SlackCredentials } from './slackSecrets'
import { connectSlackBrowser, invalidateSlackOAuth, slackUserAccessToken } from './slackOAuth'

type Fetch = typeof globalThis.fetch
let testFetch: Fetch | undefined
let generation = 0
let authorizationProblem = false
class SlackApiError extends Error { constructor(message: string, readonly authorization: boolean) { super(message) } }
export function slackAuthorizationProblem(): boolean { return authorizationProblem }
const requests = new Set<AbortController>()
export function setSlackTransportForTests(fetcher?: Fetch): void { testFetch = fetcher }
export function invalidateSlackRequests(): void { generation++; authorizationProblem = false; invalidateSlackOAuth(); for (const request of requests) request.abort() }
function transport(): Fetch { return testFetch ?? globalThis.fetch }

async function api(method: 'auth.test' | 'apps.connections.open' | 'conversations.info' | 'chat.postMessage', token: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params)
  const response = await transport()(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) })
  if (!response.ok || !response.body) throw new SlackApiError('Slack API could not be reached.', response.status === 401 || response.status === 403)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_000_000) throw new Error('Slack returned an oversized response.'); chunks.push(part.value) } } finally { reader.releaseLock() }
  let raw: unknown;try{raw=JSON.parse(Buffer.concat(chunks.map((c)=>Buffer.from(c))).toString('utf8'))}catch{throw new Error('Slack returned an invalid response.')}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).ok !== true) {
    const code = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).error : undefined
    throw new SlackApiError('Slack did not authorize the requested operation.', typeof code === 'string' && ['invalid_auth','token_revoked','account_inactive','missing_scope','not_authed','restricted_action','not_allowed_token_type','channel_not_found','not_in_channel'].includes(code))
  }
  return raw as Record<string, unknown>
}
function socketUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Slack returned an invalid socket address.')
  let url: URL; try { url = new URL(raw) } catch { throw new Error('Slack returned an invalid socket address.') }
  if (url.protocol !== 'wss:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')) || url.username || url.password) throw new Error('Slack returned an invalid socket address.')
  return url.toString()
}
export async function openSlackSocket(appToken: string): Promise<string> { return socketUrl((await api('apps.connections.open', appToken)).url) }

async function verifyTarget(token: string, channelId: string, signal?: AbortSignal): Promise<{ teamId: string; userId: string }> {
  const [identity, channel] = await Promise.all([api('auth.test', token, {}, signal), api('conversations.info', token, { channel: channelId }, signal)])
  if (typeof identity.team_id !== 'string' || !/^T[A-Z0-9]{2,30}$/.test(identity.team_id) || typeof identity.user_id !== 'string' || !/^U[A-Z0-9]{2,30}$/.test(identity.user_id) || !channel.channel || typeof channel.channel !== 'object' || (channel.channel as Record<string, unknown>).id !== channelId || (channel.channel as Record<string, unknown>).is_member === false) throw new Error('Slack did not confirm the account and channel.')
  return { teamId: identity.team_id, userId: identity.user_id }
}
export async function verifySlackConnection(): Promise<void> {
  const run = generation, saved = await readSlackCredentials()
  if (!saved) throw new Error('Slack is disconnected.')
  const token = saved.oauth ? await slackUserAccessToken() : saved.botToken
  let identity: { teamId: string; userId: string }
  try { identity = await verifyTarget(token, saved.channelId) }
  catch (error) { if (generation === run && error instanceof SlackApiError && error.authorization) authorizationProblem = true; throw error }
  if (generation !== run || identity.teamId !== saved.teamId || identity.userId !== saved.botUserId) throw new Error('Slack authorization changed.')
  if (authorizationProblem) throw new Error('Slack write authorization needs attention; reconnect the application.')
}

/** Validate both tokens and target before replacing a working saved connection. */
export async function connectSlack(input: Pick<SlackCredentials, 'appToken' | 'botToken' | 'allowedUserId' | 'channelId' | 'botId'>): Promise<Omit<SlackCredentials, 'appToken' | 'botToken'>> {
  assertSlackStorageAvailable()
  const { appToken, botToken, allowedUserId, channelId, botId } = input
  // The existing trusted IPC accepts these five fields. Empty credential
  // fields explicitly request public-client OAuth; no token-shaped sentinel.
  if (appToken === '' && botToken === '' && allowedUserId === '') {
    if (!/^[CGD][A-Z0-9]{2,30}$/.test(channelId) || !getBot(botId) || getBot(botId)?.archived) throw new Error('Select a Slack channel and an active Bot.')
    const result = await connectSlackBrowser(channelId, botId, verifyTarget)
    invalidateSlackRequests()
    return { allowedUserId: result.allowedUserId, channelId, botId, teamId: result.teamId, botUserId: result.botUserId }
  }
  if (!/^xapp-[A-Za-z0-9-]{10,500}$/.test(appToken) || !/^xoxb-[A-Za-z0-9-]{10,500}$/.test(botToken) || !/^[UW][A-Z0-9]{2,30}$/.test(allowedUserId) || !/^[CGD][A-Z0-9]{2,30}$/.test(channelId) || !getBot(botId) || getBot(botId)?.archived) throw new Error('Invalid Slack connection configuration.')
  const [identity, channel] = await Promise.all([api('auth.test', botToken), api('conversations.info', botToken, { channel: channelId })])
  if (typeof identity.team_id !== 'string' || !/^T[A-Z0-9]{2,30}$/.test(identity.team_id) || typeof identity.user_id !== 'string' || !/^U[A-Z0-9]{2,30}$/.test(identity.user_id) || !channel.channel || typeof channel.channel !== 'object' || (channel.channel as Record<string, unknown>).id !== channelId || (channel.channel as Record<string, unknown>).is_member === false) throw new Error('Slack did not confirm the account and channel.')
  await openSlackSocket(appToken)
  const credentials: SlackCredentials = { appToken, botToken, allowedUserId, channelId, botId, teamId: identity.team_id, botUserId: identity.user_id }
  await saveSlackCredentials(credentials)
  invalidateSlackRequests()
  return { allowedUserId, channelId, botId, teamId: credentials.teamId, botUserId: credentials.botUserId }
}

/** No model tool calls this; user-reviewed local drafts are the only caller. */
export async function postSlackMessage(expected: Pick<SlackCredentials, 'teamId' | 'botUserId' | 'channelId'>, text: string, threadTs?: string): Promise<{ channel: string; ts: string }> {
  const at = generation, credentials = await readSlackCredentials()
  if (!credentials || generation !== at || credentials.teamId !== expected.teamId || credentials.botUserId !== expected.botUserId || credentials.channelId !== expected.channelId) throw new Error('The Slack connection for this draft changed.')
  const controller = new AbortController(); requests.add(controller)
  try {
    const token = credentials.oauth ? await slackUserAccessToken() : credentials.botToken
    if (generation !== at) throw new Error('Slack authorization changed before sending.')
    const response = await api('chat.postMessage', token, { channel: expected.channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, controller.signal)
    if (generation !== at || response.channel !== expected.channelId || typeof response.ts !== 'string' || !/^\d+\.\d+$/.test(response.ts)) throw new Error('Slack send result could not be confirmed.')
    authorizationProblem = false
    return { channel: expected.channelId, ts: response.ts }
  } catch (error) { if (generation === at && error instanceof SlackApiError && error.authorization) authorizationProblem = true; throw error }
  finally { requests.delete(controller) }
}
