/** IPC for GitHub, Git, and Gmail. Probes stay in `apps/status.ts`. */

import type { AppStatus } from '../../shared/apps'
import { appStatuses, connectGit, connectGitHub, requestGmail } from '../apps/status'
import { CHANNELS } from './channels'
import { emptyArray, handle } from './handler'

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function registerAppIpc(): void {
  handle<AppStatus[]>(CHANNELS.appsStatus, () => appStatuses(), emptyArray)
  handle<{ started: boolean }>(CHANNELS.appsConnectGitHub, () => connectGitHub(), () => ({ started: false }))
  handle<AppStatus>(
    CHANNELS.appsConnectGit,
    (args) => connectGit(text(args[0], 80), text(args[1], 120)),
    () => ({ id: 'git', status: 'disconnected', detail: 'failed' })
  )
  handle<AppStatus>(CHANNELS.appsRequestGmail, () => requestGmail(), () => ({ id: 'gmail', status: 'disconnected' }))
}
