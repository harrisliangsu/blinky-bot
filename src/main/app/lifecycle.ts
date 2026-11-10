/**
 * App-level lifecycle: macOS window conventions, single-instance behaviour,
 * and the orderly shutdown — flush pending writes, stop child processes —
 * before the process goes away.
 */

import { BrowserWindow, app, dialog } from 'electron'
import { flushStore } from '../store'
import { stopChildProcesses } from './shutdown'
import { createWindow, focusOrCreateWindow } from './window'
import { stopRoutineScheduler } from '../routines/scheduler'
import { getSettings, onSettingsChanged } from '../settings'
import { stopCollaborationServer } from '../collaboration/server'
import { stopRoutineLauncher, syncRoutineLauncher } from './routineLauncher'

let shutdownRun: Promise<void> | null = null
let readyToQuit = false

/** How many failed paths are worth naming before the list stops helping. */
const MAX_LISTED_FILES = 5
/** A broken/in-flight store write must not make Cmd-Q wait forever. */
const FLUSH_DEADLINE_MS = 5000

async function flushBeforeQuit(): Promise<Awaited<ReturnType<typeof flushStore>> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      flushStore(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FLUSH_DEADLINE_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Never close silently on a failed flush.
 *
 * Every write error used to be swallowed on the way down, so quitting with an
 * unwritable data directory looked exactly like quitting with everything saved —
 * and the chat the user had just been typing in was simply not there the next
 * morning. A blocking dialog on the way out is the last moment anything can say
 * so; it is deliberately modal, because the alternative is a console line nobody
 * will ever read.
 */
function warnUnsaved(files: string[]): void {
  console.error('[openbot] quitting with unsaved changes', files)
  const named = files.slice(0, MAX_LISTED_FILES).join('\n')
  const more = files.length > MAX_LISTED_FILES ? `\n…and ${files.length - MAX_LISTED_FILES} more` : ''
  try {
    dialog.showErrorBox(
      'BlinkyBot could not save your latest changes',
      `Some data could not be written to disk and will be missing when you reopen BlinkyBot.` +
        `\n\nCheck that the data folder is writable and that the disk is not full.` +
        (named ? `\n\n${named}${more}` : '')
    )
  } catch (err) {
    console.error('[openbot] could not show the unsaved-changes warning', err)
  }
}

/**
 * Persist, then tear down.
 *
 * The store flush is what the user would actually miss, so it is awaited first
 * and on its own: a child process that hangs on the way out must not be able to
 * take the last chat message with it. A failure is reported rather than
 * swallowed, but never blocks the teardown.
 */
async function shutdown(): Promise<void> {
  stopRoutineScheduler()
  stopRoutineLauncher()
  await stopCollaborationServer('host-exit').catch((error) => console.warn('[openbot] collaboration server did not stop cleanly', error))
  try {
    const report = await flushBeforeQuit()
    if (!report) {
      console.error(`[openbot] store flush did not finish within ${FLUSH_DEADLINE_MS}ms`)
      warnUnsaved([])
    } else if (report.failed.length > 0 || report.stillWriting) {
      warnUnsaved(report.failed)
    }
  } catch (err) {
    console.error('[openbot] flush on quit failed', err)
    warnUnsaved([])
  }
  await stopChildProcesses()
  // The background registration is secondary to saving the chat. Bound its
  // shutdown time so an unresponsive launchd cannot prevent the final flush.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([syncRoutineLauncher(), new Promise<void>((resolve) => { timer = setTimeout(resolve, FLUSH_DEADLINE_MS) })])
  } finally { if (timer) clearTimeout(timer) }
  // Child shutdown and launcher diagnostics may themselves write records.
  const tail = await flushBeforeQuit().catch(() => null)
  if (!tail || tail.failed.length || tail.stillWriting) warnUnsaved(tail?.failed ?? [])
}

/** Take the single-instance lock. Returns false if another copy is running. */
export function claimSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) return false
  app.on('second-instance', (_event, argv) => {
    // A periodic background wake must never steal focus from an open app.
    if (argv.includes('--routine-runner')) return
    if (process.platform === 'darwin') void app.dock?.show()
    focusOrCreateWindow()
  })
  return true
}

export function installLifecycle(): void {
  // Background mode keeps the coordinator and scheduler alive without a UI.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && getSettings().runInBackground !== true) app.quit()
  })

  // Clicking the dock icon with no windows open re-creates one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Debounced writes must land, and children must be stopped, before the
  // process exits. The quit is held until both are done; pressing Cmd-Q again
  // meanwhile joins the run already under way rather than cutting it short.
  app.on('before-quit', (event) => {
    if (readyToQuit) return
    event.preventDefault()
    if (shutdownRun) return
    shutdownRun = shutdown().finally(() => {
      readyToQuit = true
      // Re-entering `app.quit()` from a prevented macOS quit can close the
      // renderer yet strand the main/GPU processes. All application-owned
      // teardown is complete at this point, so finish the process directly.
      app.exit(0)
    })
  })
}

/**
 * Login-item registration follows `launchAtLogin`.
 * `runInBackground` only decides whether closing the window quits the app.
 * macOS rejects login-item registration for an unsigned development launch
 * and logs a native process error before JavaScript can catch it, so the
 * call is limited to the packaged app. The preference is still stored.
 */
export function installBackgroundMode(): void {
  const apply = (): void => {
    if (!app.isPackaged) return
    const { launchAtLogin, runInBackground } = getSettings()
    try {
      app.setLoginItemSettings({
        openAtLogin: launchAtLogin === true,
        openAsHidden: launchAtLogin === true && runInBackground === true
      })
    } catch (error) {
      console.warn('[openbot] could not update login-item settings', error)
    }
  }
  apply()
  onSettingsChanged(() => apply())
}
