/** Per-user launchd wake-up for local routines. It never owns the app process. */
import { app } from 'electron'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getSettings, onSettingsChanged, settingsAreUnreadable } from '../settings'
import { dataRoot } from '../store/paths'
import { listRoutines, routinesLoadWasIncomplete } from '../store/routines'
import { postActivity } from '../ipc/broadcast'
import { listActivity } from '../store/activity'
import { reconcileRoutineJob, type RoutineJobOptions } from './routineLaunchJob'
import { readSlackCredentials } from '../connectors/slackSecrets'
import { listRoutineRuns } from '../routines/runs'

const LABEL = 'bot.blinky.shell.routine-runner'
export type RoutineLauncherStatus = { state: 'inactive' | 'active' | 'error' | 'unavailable'; error?: string }
let status: RoutineLauncherStatus = { state: 'inactive' }, queue: Promise<unknown> = Promise.resolve(), timer: ReturnType<typeof setInterval> | undefined
let enabledForApp = false

export function getRoutineLauncherStatus(): RoutineLauncherStatus { return enabledForApp ? status : { state: 'unavailable' } }
export function syncRoutineLauncher(): Promise<void> {
  if (!enabledForApp) return Promise.resolve()
  const work = queue.then(async () => {
    try {
      if (settingsAreUnreadable() || routinesLoadWasIncomplete()) throw new Error('Settings or routines could not be read; the background task was left unchanged.')
      const routines = listRoutines()
      // Manual runs change the routine header in either direction. The exact
      // occurrence ledger, including missed/skipped claims, owns consumption.
      const pendingOnce = await Promise.all(routines.filter(r => r.trigger.kind === 'once').map(async r =>
        !(await listRoutineRuns(r.id)).some(run => run.scheduledAt === r.trigger.at)))
      const hasAutomatic = pendingOnce.some(Boolean) || routines.some((r) => r.trigger.kind === 'schedule' || r.trigger.kind === 'folder_change' ||
        r.trigger.kind === 'github_issue' || r.trigger.kind === 'gmail_query' || r.trigger.kind === 'webhook') || !!(await readSlackCredentials())
      const options: RoutineJobOptions = {
        label: LABEL,
        plistPath: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
        markerPath: join(dataRoot(), 'routine-launcher-owner.json'),
        bundle: dirname(dirname(dirname(app.getPath('exe')))),
        enabled: getSettings().runRoutinesWhenClosed !== false && hasAutomatic,
        uid: process.getuid?.() ?? -1
      }
      status = await reconcileRoutineJob(options)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Background routine setup failed.'
      if ((status.state !== 'error' || status.error !== message) && !listActivity().some((item) => !item.read && item.title === '后台例程不可用' && item.detail === message)) postActivity('failed', '后台例程不可用', message, undefined, undefined, true)
      status = { state: 'error', error: message }
    }
  })
  queue = work.catch(() => undefined)
  return work
}

/** Only formal packaged apps install a system service; Preview and tests do not. */
export function installRoutineLauncher(): void {
  if (enabledForApp || process.platform !== 'darwin' || !app.isPackaged || process.env.BLINKY_SMOKE === '1' || process.env.BLINKY_SHOTS === '1') return
  // launchd cannot inherit an ad-hoc data override from this process. Never
  // register a runner that would wake against a different store.
  if (process.env.OPENBOT_DATA_DIR && resolve(process.env.OPENBOT_DATA_DIR) !== resolve(app.getPath('userData'))) return
  enabledForApp = true
  void syncRoutineLauncher()
  onSettingsChanged(() => { void syncRoutineLauncher() })
  timer = setInterval(() => void syncRoutineLauncher(), 30000)
  timer.unref?.()
}

export function stopRoutineLauncher(): void { if (timer) clearInterval(timer); timer = undefined }
