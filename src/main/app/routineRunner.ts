import { app, BrowserWindow } from 'electron'
import { runningSessionIds } from '../agent/cancel'
import { countActiveTasks } from '../store/tasks'
import { routineSchedulerBusy } from '../routines/scheduler'
import { slackShouldStayAlive } from '../connectors/slackSocket'
import { webhookShouldStayAlive } from '../routines/webhookServer'

/** A launched worker is the ordinary app without a window, sharing its single-instance lock. */
export function installRunnerIdleExit(): void {
  let idleSince = 0
  const timer = setInterval(() => {
    // A normal launch promoted this worker into the interactive application.
    if (BrowserWindow.getAllWindows().length) { clearInterval(timer); return }
    if (routineSchedulerBusy() || runningSessionIds().length || countActiveTasks() || slackShouldStayAlive() || webhookShouldStayAlive()) { idleSince = 0; return }
    if (!idleSince) idleSince = Date.now()
    if (Date.now() - idleSince >= 5000) { clearInterval(timer); app.quit() }
  }, 1000)
  timer.unref?.()
}
