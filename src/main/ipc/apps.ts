/** IPC for app connections. The Apps grid shows GitHub, Gmail, and X. Probes stay in `apps/status.ts`. */

import type { AppStatus } from '../../shared/apps'
import { appStatus, appStatuses, connectGit, invalidateGitHubStatus, invalidateGoogleStatus, invalidateXStatus, requestGmail } from '../apps/status'
import { captureAppToolIntent, finishAppToolIntent, invalidateAppToolIntent, type AppToolIntent } from '../apps/toolAccess'
import { isConnectedApp } from '../../shared/connectedAppTools'
import { cancelGoogleConnect, connectGoogle, disconnectGoogle } from '../connectors/googleOAuth'
import type { GoogleService } from '../connectors/googleSecrets'
import { connectSlack, invalidateSlackRequests } from '../connectors/slackApi'
import { clearSlackCredentials } from '../connectors/slackSecrets'
import { restartSlackSocket, slackConnectionState, stopSlackSocket } from '../connectors/slackSocket'
import { syncRoutineLauncher } from '../app/routineLauncher'
import { cancelXConnect, connectX, disconnectX } from '../connectors/xOAuth'
import { cancelGitHubConnect, connectGitHub, disconnectGitHub } from '../connectors/githubOAuth'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleEvent } from './handler'

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

let slackJob: Promise<unknown> | null = null
let slackEpoch = 0
let xJob: Promise<unknown> | null = null, xEpoch = 0
let githubJob: Promise<unknown> | null = null, githubEpoch = 0

export function registerAppIpc(): void {
  handle<AppStatus[]>(CHANNELS.appsStatus, () => appStatuses(), emptyArray)
  handleEvent<{ ok: boolean; error?: string }>(CHANNELS.appsConnectGitHub, async (_event, [clientId, clientSecret, botId]) => {
    if (githubJob || typeof clientId !== 'string' || clientId.length > 200 || typeof clientSecret !== 'string' || clientSecret.length > 1024) return { ok: false }
    let intent: AppToolIntent | undefined
    try { intent = captureAppToolIntent('github', botId) } catch { return { ok: false, error: 'Choose an available Bot.' } }
    const epoch = githubEpoch, job = connectGitHub(clientId, clientSecret); githubJob = job
    let connected = false
    try { await job; connected = true; if (epoch !== githubEpoch) return { ok: false }; invalidateGitHubStatus(); await finishAppToolIntent(intent); return { ok: true } }
    catch { return { ok: false, ...(connected ? { error: '应用已连接，但 Bot 工具授权未保存。请重新允许此 Bot 使用应用。 / Connected, but Bot tool access was not saved. Allow this Bot again.' } : {}) } }
    finally { if (githubJob === job) githubJob = null }
  }, () => ({ ok: false }))
  handleEvent<void>(CHANNELS.appsCancelGitHub, () => { githubEpoch++; invalidateAppToolIntent('github'); cancelGitHubConnect() }, () => undefined)
  handleEvent<{ ok: boolean }>(CHANNELS.appsDisconnectGitHub, async () => {
    githubEpoch++; invalidateAppToolIntent('github'); invalidateGitHubStatus()
    try { await disconnectGitHub(); invalidateGitHubStatus(); return { ok: true } } catch { return { ok: false } }
  }, () => ({ ok: false }))
  handleEvent('openbot:apps:setBotAccess', async (event, [service, botId, enabled]) => {
    if (!isConnectedApp(service) || typeof enabled !== 'boolean') return { ok: false, error: 'Invalid app access choice.' }
    if (!event.sender.isFocused() || !await event.senderFrame?.executeJavaScript('navigator.userActivation.isActive')) return { ok: false, error: '请在 Mac 设置中确认此 Bot 的应用使用权限。 / Confirm app access in the Mac settings window.' }
    try {
      const intent = captureAppToolIntent(service, botId)
      if (!intent) throw new Error('Choose a Bot.')
      if (enabled && (await appStatus(service)).status !== 'connected') return { ok: false, error: '应用尚未连接，未增加工具权限。 / Connect this app before allowing its tools.' }
      return { ok: true, bot: await finishAppToolIntent(intent, enabled) }
    } catch { return { ok: false, error: 'Bot 应用权限未能保存，请重试。 / Bot app access could not be saved. Try again.' } }
  }, () => ({ ok: false, error: 'Bot app access could not be saved.' }))
  handle<AppStatus>(
    CHANNELS.appsConnectGit,
    (args) => connectGit(text(args[0], 80), text(args[1], 120)),
    () => ({ id: 'git', status: 'disconnected', detail: 'failed' })
  )
  handle<AppStatus>(CHANNELS.appsRequestGmail, () => requestGmail(), () => ({ id: 'gmail', status: 'disconnected' }))
  // User-entered OAuth client credentials are accepted only from a trusted app
  // window, never from the native agent bridge or model tools.
  handleEvent<{ ok: boolean; error?: string }>(CHANNELS.appsConnectGoogle, async (_event, [rawService, rawClient, rawSecret, rawOptions]) => {
    let connected = false
    try {
      if ((rawService !== 'gmail' && rawService !== 'calendar') || typeof rawClient !== 'string' || rawClient.length > 300 || typeof rawSecret !== 'string' || rawSecret.length > 1024) throw new Error('invalid configuration')
      if (rawOptions !== undefined && (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions) || Object.keys(rawOptions).some(key => !['addAccount', 'accountId', 'botId'].includes(key)))) throw new Error('invalid options')
      const { botId, ...options } = (rawOptions ?? {}) as { botId?: unknown; addAccount?: boolean; accountId?: string }
      const intent = captureAppToolIntent(rawService, botId)
      await connectGoogle(rawService, rawClient, rawSecret, rawOptions === undefined ? undefined : options)
      connected = true
      invalidateGoogleStatus(rawService)
      await finishAppToolIntent(intent)
      return { ok: true }
    } catch { return { ok: false, error: connected ? '应用已连接，但 Bot 工具授权未保存。请重新允许此 Bot 使用应用。 / Connected, but Bot tool access was not saved. Allow this Bot again.' : 'Google authorization did not complete. Check the client, permissions, API availability, and network.' } }
  }, () => ({ ok: false, error: 'Google authorization could not be started.' }))
  handleEvent<void>(CHANNELS.appsCancelGoogle, () => { invalidateAppToolIntent('gmail'); invalidateAppToolIntent('calendar'); cancelGoogleConnect() }, () => undefined)
  handleEvent<{ ok: boolean; error?: string }>(CHANNELS.appsConnectX, async (_event, [clientId, botId]) => {
    if (xJob || typeof clientId !== 'string' || clientId.length > 500) return { ok: false }
    let intent: AppToolIntent | undefined
    try { intent = captureAppToolIntent('x', botId) } catch { return { ok: false, error: 'Choose an available Bot.' } }
    const epoch = xEpoch, job = connectX(clientId); xJob = job
    let connected = false
    try { await job; connected = true; if (epoch !== xEpoch) return { ok: false }; invalidateXStatus(); await finishAppToolIntent(intent); return { ok: true } }
    catch { return { ok: false, ...(connected ? { error: '应用已连接，但 Bot 工具授权未保存。请重新允许此 Bot 使用应用。 / Connected, but Bot tool access was not saved. Allow this Bot again.' } : {}) } } finally { if (xJob === job) xJob = null }
  }, () => ({ ok: false }))
  handleEvent<void>(CHANNELS.appsCancelX, () => { xEpoch++; invalidateAppToolIntent('x'); cancelXConnect() }, () => undefined)
  handleEvent<{ ok: boolean }>(CHANNELS.appsDisconnectX, async () => {
    xEpoch++; invalidateAppToolIntent('x'); invalidateXStatus()
    try { await disconnectX(); invalidateXStatus(); return { ok: true } } catch { return { ok: false } }
  }, () => ({ ok: false }))
  handleEvent<{ ok: boolean }>(CHANNELS.appsDisconnectGoogle, async (_event, [raw, accountId]) => {
    try {
      if (raw !== 'gmail' && raw !== 'calendar') throw new Error('invalid service')
      invalidateAppToolIntent(raw)
      if (accountId !== undefined && (typeof accountId !== 'string' || !/^g_[a-f0-9]{24}$/.test(accountId))) throw new Error('invalid account')
      const service: GoogleService = raw
      invalidateGoogleStatus(service)
      await disconnectGoogle(service, accountId as string | undefined)
      invalidateGoogleStatus(service)
      return { ok: true }
    } catch { return { ok: false } }
  }, () => ({ ok: false }))
  handleEvent(CHANNELS.appsSlackStatus, () => slackConnectionState(), () => ({ state: 'error' as const }))
  handleEvent<{ ok: boolean; error?: string }>(CHANNELS.appsConnectSlack, async (_event, [raw]) => {
    if (slackJob || !raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
    const input = raw as Record<string, unknown>
    if (['appToken','botToken','allowedUserId','channelId','botId'].some((key) => typeof input[key] !== 'string' || (input[key] as string).length > 600)) return { ok: false }
    let intent: AppToolIntent | undefined
    try { intent = captureAppToolIntent('slack', input.accessBotId ?? input.botId) } catch { return { ok: false } }
    const epoch = slackEpoch
    const job = connectSlack({ appToken: (input.appToken as string).trim(), botToken: (input.botToken as string).trim(), allowedUserId: (input.allowedUserId as string).trim(), channelId: (input.channelId as string).trim(), botId: input.botId as string })
    slackJob = job
    let connected = false
    try {
      await job
      connected = true
      if (epoch !== slackEpoch) return { ok: false }
      await restartSlackSocket(); void syncRoutineLauncher()
      await finishAppToolIntent(intent)
      return { ok: true }
    } catch { return { ok: false, ...(connected ? { error: '应用已连接，但 Bot 工具授权未保存。请重新允许此 Bot 使用应用。 / Connected, but Bot tool access was not saved. Allow this Bot again.' } : {}) } } finally { if (slackJob === job) slackJob = null }
  }, () => ({ ok: false }))
  handleEvent<{ ok: boolean }>(CHANNELS.appsDisconnectSlack, async () => {
    slackEpoch++; invalidateAppToolIntent('slack'); stopSlackSocket(); invalidateSlackRequests()
    try { await slackJob?.catch(() => undefined); stopSlackSocket(); await clearSlackCredentials(); void syncRoutineLauncher(); return { ok: true } }
    catch { await restartSlackSocket(); return { ok: false } }
  }, () => ({ ok: false }))
}
