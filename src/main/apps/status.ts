/**
 * Connection probes shared by every Bot.
 * The Apps grid shows GitHub, Gmail, and X; Git, Calendar, and Slack stay probed but hidden.
 *
 * GitHub uses the official `gh auth` flow and does not keep the token.
 * Git reads and writes the global identity already on this Mac.
 * Google statuses require an actual token refresh and service API check.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppStatus } from '../../shared/apps'
import { startExternalLogin } from '../app/externalLogin'
import { which } from '../backends/which'
import { hydratedEnv } from '../backends/loginShellEnv'
import { getSettings, updateSettings } from '../settings'
import { listGoogleAccounts, type GoogleService } from '../connectors/googleSecrets'
import { hasGoogleClient, verifyGoogleConnection } from '../connectors/googleOAuth'
import { slackConnectionState } from '../connectors/slackSocket'
import { readXCredentials } from '../connectors/xSecrets'
import { hasXClient, verifyXConnection } from '../connectors/xOAuth'
import { gitProbeFailed, githubProbeState, type CommandProbe } from './statusClassification'
import { githubEnabled, setGitHubEnabled } from '../connectors/githubConnection'

const run = promisify(execFile)

async function capture(binary: string, args: string[]): Promise<CommandProbe> {
  try {
    const result = await run(binary, args, { timeout: 8000, maxBuffer: 64 * 1024, env: await hydratedEnv() })
    return { ok: true, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (error) {
    const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout ?? '') : ''
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr ?? '') : ''
    const code = typeof error === 'object' && error && 'code' in error && typeof error.code === 'number' ? error.code : undefined
    return { ok: false, stdout, stderr, code }
  }
}

async function githubStatus(): Promise<AppStatus> {
  try { if (!await githubEnabled()) return { id: 'github', status: 'disconnected', detail: 'disabled' } }
  catch { return { id: 'github', status: 'unavailable', detail: 'verification-failed' } }
  const binary = await which('gh')
  if (!binary) {
    return {
      id: 'github',
      status: 'unavailable',
      detail: 'gh'
    }
  }
  const probe = await capture(binary, ['auth', 'status', '--hostname', 'github.com'])
  const status = githubProbeState(probe)
  if (status === 'connected') {
    // auth status alone is insufficient: verify the identity the connector
    // will actually use (including environment-token overrides).
    const identity = await capture(binary, ['api', '--hostname', 'github.com', 'user', '--jq', '.login'])
    const account = identity.stdout.trim()
    return identity.ok && /^[A-Za-z0-9-]{1,39}$/.test(account)
      ? { id: 'github', status, account }
      : { id: 'github', status: 'unavailable', detail: 'verification-failed' }
  }
  return status === 'unavailable' ? { id: 'github', status, detail: 'verification-failed' } : { id: 'github', status }
}

async function gitStatus(): Promise<AppStatus> {
  const binary = await which('git')
  if (!binary) return { id: 'git', status: 'unavailable', detail: 'git' }
  const name = await capture(binary, ['config', '--global', '--get', 'user.name'])
  const email = await capture(binary, ['config', '--global', '--get', 'user.email'])
  if (gitProbeFailed(name) || gitProbeFailed(email)) return { id: 'git', status: 'unavailable', detail: 'verification-failed' }
  const user = name.ok ? name.stdout.trim() : ''
  const mail = email.ok ? email.stdout.trim() : ''
  if (user && mail) return { id: 'git', status: 'connected', account: `${user} <${mail}>` }
  return { id: 'git', status: 'disconnected' }
}

const googleCache = new Map<GoogleService, { value: AppStatus; at: number }>()
const googleGeneration = new Map<GoogleService, number>()
export function invalidateGoogleStatus(service: GoogleService): void { googleCache.delete(service); googleGeneration.set(service, (googleGeneration.get(service) ?? 0) + 1) }
let xCache: { value: AppStatus; at: number } | undefined, xGeneration = 0
export function invalidateXStatus(): void { xCache = undefined; xGeneration++ }
async function xStatus(): Promise<AppStatus> {
  if (xCache && Date.now() - xCache.at < 30_000) return xCache.value
  const generation = xGeneration
  let value: AppStatus, hasSavedClient = false
  try { const saved = await readXCredentials(); hasSavedClient = !!saved; value = saved ? { id: 'x', status: 'connected', account: (await verifyXConnection()).username } : { id: 'x', status: 'disconnected', detail: await hasXClient() ? 'oauth-ready' : 'oauth-client-required' } }
  catch { value = { id: 'x', status: 'unavailable', detail: hasSavedClient ? 'verification-failed-with-client' : 'verification-failed' } }
  if (generation !== xGeneration) return xStatus()
  xCache = { value, at: Date.now() }; return value
}
async function googleStatus(service: GoogleService): Promise<AppStatus> {
  const cached = googleCache.get(service)
  if (cached && Date.now() - cached.at < 30_000) return cached.value
  const generation = googleGeneration.get(service) ?? 0
  let value: AppStatus, hasSavedClient = false
  try {
    const saved = await listGoogleAccounts(service)
    hasSavedClient = saved.length > 0
    const accounts: NonNullable<AppStatus['accounts']> = await Promise.all(saved.map(async info => {
      try { const verified = await verifyGoogleConnection(service, info.id); return { ...info, label: verified.account, status: 'connected' as const } }
      catch { return { ...info, status: 'unavailable' as const, detail: 'verification-failed-with-client' } }
    }))
    const original = accounts.find(info => info.isDefault)
    value = original ? { id: service, status: original.status, account: original.label, ...(original.detail ? { detail: original.detail } : {}), accounts }
      : { id: service, status: 'disconnected', detail: await hasGoogleClient(service) ? 'oauth-ready' : 'oauth-client-required', accounts }
  } catch { value = { id: service, status: 'unavailable', detail: hasSavedClient ? 'verification-failed-with-client' : 'verification-failed' } }
  if ((googleGeneration.get(service) ?? 0) !== generation) return googleStatus(service)
  googleCache.set(service, { value, at: Date.now() })
  return value
}
/** Renderer/model metadata only; no credentials or access tokens leave this boundary. */
export async function googleAccountStatuses(service: GoogleService): Promise<NonNullable<AppStatus['accounts']>> {
  const value = await googleStatus(service)
  if (!value.accounts && value.status === 'unavailable') throw new Error('Google accounts could not be read or verified.')
  return value.accounts ?? []
}

export async function appStatuses(): Promise<AppStatus[]> {
  const [github, git, gmail, calendar, x] = await Promise.all([githubStatus(), gitStatus(), googleStatus('gmail'), googleStatus('calendar'), xStatus()])
  const slack = slackConnectionState()
  const slackStatus: AppStatus = { id: 'slack', status: slack.state === 'connected' ? 'connected' : slack.state === 'connecting' ? 'pending' : slack.state === 'error' ? 'unavailable' : 'disconnected', ...(slack.teamId ? { account: slack.teamId } : {}) }
  return [github, git, gmail, calendar, slackStatus, x]
}

/** Check only the service the user is granting, without probing unrelated accounts. */
export async function appStatus(id: AppStatus['id']): Promise<AppStatus> {
  if (id === 'github') return githubStatus()
  if (id === 'git') return gitStatus()
  if (id === 'gmail' || id === 'calendar') return googleStatus(id)
  if (id === 'x') return xStatus()
  const slack = slackConnectionState()
  return { id: 'slack', status: slack.state === 'connected' ? 'connected' : slack.state === 'connecting' ? 'pending' : slack.state === 'error' ? 'unavailable' : 'disconnected' }
}

export async function connectGitHub(): Promise<{ started: boolean }> {
  const binary = await which('gh')
  if (!binary) return { started: false }
  // Reuse a login the user already owns; no token is copied into BlinkyBot.
  const identity = await capture(binary, ['api', '--hostname', 'github.com', 'user', '--jq', '.login'])
  if (identity.ok && /^[A-Za-z0-9-]{1,39}$/.test(identity.stdout.trim())) { await setGitHubEnabled(true); return { started: true } }
  await setGitHubEnabled(true)
  return startExternalLogin('github', binary, ['auth', 'login', '--web', '--hostname', 'github.com'])
}

export async function disconnectGitHub(): Promise<{ ok: boolean }> {
  await setGitHubEnabled(false)
  return { ok: true }
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

export async function connectGit(name: string, email: string): Promise<AppStatus> {
  const binary = await which('git')
  if (!binary) return { id: 'git', status: 'unavailable', detail: 'git' }
  const user = clean(name, 80)
  const mail = clean(email, 120)
  if (!user || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return { id: 'git', status: 'disconnected', detail: 'invalid' }
  }
  const named = await capture(binary, ['config', '--global', 'user.name', user])
  const mailed = await capture(binary, ['config', '--global', 'user.email', mail])
  if (!named.ok || !mailed.ok) return { id: 'git', status: 'disconnected', detail: 'failed' }
  return { id: 'git', status: 'connected', account: `${user} <${mail}>` }
}

export function requestGmail(): AppStatus {
  updateSettings({ apps: { ...getSettings().apps, gmail: { pending: true } } })
  return { id: 'gmail', status: 'pending' }
}
