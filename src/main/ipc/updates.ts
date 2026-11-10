/** IPC for the version shown in Settings and the Check now button. */

import { app } from 'electron'
import type { UpdateReport } from '../../shared/types'
import { openBlinkyRelease } from '../updates/releaseLink'
import { runUpdateCheck } from '../updates/service'
import { CHANNELS } from './channels'
import { handle } from './handler'

function emptyReport(error: unknown): UpdateReport {
  return {
    channel: 'stable',
    current: app.getVersion() || 'dev',
    latest: null,
    url: null,
    updateAvailable: false,
    note: error instanceof Error ? error.message : 'The update check failed.',
    status: 'error',
    installable: false
  }
}

export function registerUpdateIpc(): void {
  handle<string>(CHANNELS.appVersion, () => app.getVersion() || 'dev', () => 'dev')
  handle<UpdateReport>(
    CHANNELS.appCheckUpdate,
    ([channel]) => runUpdateCheck('manual', channel === 'beta' ? 'beta' : 'stable'),
    (_args, error) => emptyReport(error)
  )
  handle<boolean>(
    CHANNELS.appOpenRelease,
    ([value]) => openBlinkyRelease(typeof value === 'string' ? value : ''),
    () => false
  )
}
