/** IPC for the version shown in Settings and the Check now button. */

import { app, shell } from 'electron'
import type { UpdateReport } from '../../shared/types'
import { checkForUpdate } from '../updates/check'
import { CHANNELS } from './channels'
import { handle } from './handler'

const RELEASE_HOSTS = new Set(['github.com', 'www.github.com'])

function emptyReport(error: unknown): UpdateReport {
  return {
    channel: 'stable',
    current: app.getVersion() || 'dev',
    latest: null,
    url: null,
    updateAvailable: false,
    note: error instanceof Error ? error.message : 'The update check failed.'
  }
}

export function registerUpdateIpc(): void {
  handle<string>(CHANNELS.appVersion, () => app.getVersion() || 'dev', () => 'dev')
  handle<UpdateReport>(
    CHANNELS.appCheckUpdate,
    ([channel]) => checkForUpdate(channel === 'beta' ? 'beta' : 'stable'),
    (_args, error) => emptyReport(error)
  )
  handle<boolean>(
    CHANNELS.appOpenRelease,
    ([value]) => {
      if (typeof value !== 'string') return false
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return false
      }
      if (url.protocol !== 'https:' || !RELEASE_HOSTS.has(url.hostname)) return false
      if (!url.pathname.startsWith('/harrisliangsu/blinky-bot')) return false
      void shell.openExternal(url.toString())
      return true
    },
    () => false
  )
}
