/**
 * GitHub, Git, and Gmail connections shared by every Bot.
 *
 * GitHub uses the official `gh auth` flow and does not keep the token.
 * Git reads and writes the global identity already on this Mac.
 * Gmail has no OAuth client in this build: asking to connect is recorded,
 * and the status stays pending instead of pretending the mailbox is linked.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppStatus } from '../../shared/apps'
import { startExternalLogin } from '../app/externalLogin'
import { which } from '../backends/which'
import { getSettings, updateSettings } from '../settings'

const run = promisify(execFile)

async function capture(binary: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await run(binary, args, { timeout: 8000, maxBuffer: 64 * 1024 })
    return { ok: true, stdout: String(result.stdout ?? '') }
  } catch (error) {
    const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout ?? '') : ''
    return { ok: false, stdout }
  }
}

function githubAccount(text: string): string | undefined {
  const match = /account\s+(\S+)/i.exec(text)
  return match?.[1]
}

async function githubStatus(): Promise<AppStatus> {
  const binary = await which('gh')
  if (!binary) {
    return {
      id: 'github',
      status: 'unavailable',
      detail: 'gh'
    }
  }
  const probe = await capture(binary, ['auth', 'status'])
  const account = githubAccount(`${probe.stdout}`)
  if (probe.ok) return { id: 'github', status: 'connected', ...(account ? { account } : {}) }
  return { id: 'github', status: 'disconnected' }
}

async function gitStatus(): Promise<AppStatus> {
  const binary = await which('git')
  if (!binary) return { id: 'git', status: 'unavailable', detail: 'git' }
  const name = await capture(binary, ['config', '--global', '--get', 'user.name'])
  const email = await capture(binary, ['config', '--global', '--get', 'user.email'])
  const user = name.ok ? name.stdout.trim() : ''
  const mail = email.ok ? email.stdout.trim() : ''
  if (user && mail) return { id: 'git', status: 'connected', account: `${user} <${mail}>` }
  return { id: 'git', status: 'disconnected' }
}

function gmailStatus(): AppStatus {
  if (getSettings().apps.gmail?.pending === true) return { id: 'gmail', status: 'pending' }
  return { id: 'gmail', status: 'disconnected' }
}

export async function appStatuses(): Promise<AppStatus[]> {
  const [github, git] = await Promise.all([githubStatus(), gitStatus()])
  return [github, git, gmailStatus()]
}

export async function connectGitHub(): Promise<{ started: boolean }> {
  const binary = await which('gh')
  if (!binary) return { started: false }
  return startExternalLogin('github', binary, ['auth', 'login'])
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
