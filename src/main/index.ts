/**
 * OpenBOT main process entry.
 *
 * Boot order matters: storage first (settings feed bot seeding), then the IPC
 * surface, then the menu and window — so the renderer never sees a channel
 * that is not yet registered.
 */

import { app } from 'electron'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { installBackgroundMode, installLifecycle, claimSingleInstance } from './app/lifecycle'
import { installMenu } from './app/menu'
import { installSecurity } from './app/security'
import { prepareShots } from './app/shots'
import { markSmokeFailed, markSmokeReady, prepareSmoke } from './app/smoke'
import { installRunnerIdleExit } from './app/routineRunner'
import { installRoutineLauncher } from './app/routineLauncher'
import { getSettings, settingsAreUnreadable } from './settings'
import { createWindow, installWindowChrome } from './app/window'
import { registerIpc } from './ipc'
import { flushStore, initStore } from './store'
import { startRoutineScheduler } from './routines/scheduler'
import { installWebhookService, stopWebhookService } from './routines/webhookServer'
import { installWebhookDelivery, stopWebhookDelivery } from './routines/webhookDelivery'
import { botsLoadWasIncomplete, listBots } from './store/bots'
import { vmToken } from './store/vmSecrets'
import { cleanupOrphanedAppleVms, startAppleVm } from './vm/appleVmSupervisor'
import { installQueueRuntime } from './agent/messageQueueRuntime'
import { recoverMemoryExtractions } from './agent/memory'
import { installTaskInbox } from './tasks'
import { installTaskProgressMonitor, stopTaskProgressMonitor } from './tasks/progressRuntime'
import { installSemanticMemory } from './agent/semanticMemory'
import { installTelemetry, stopTelemetry } from './telemetry'
import { installGitHubDraftInbox } from './connectors/githubDraftInbox'
import { installGmailDraftInbox } from './connectors/gmailDraftInbox'
import { installCalendarDraftInbox } from './connectors/calendarDraftInbox'
import { installXDraftInbox } from './connectors/xDraftInbox'
import { installSlackInbox } from './connectors/slackInbox'
import { installSlackSocket, stopSlackSocket } from './connectors/slackSocket'
import { installSlackDraftInbox } from './connectors/slackDraftInbox'
import { registerNativeHandler, startNativeBridge } from './native/stdioBridge'
import { stopChildProcesses } from './app/shutdown'
import { PROVIDER_CATALOG } from '../shared/providerCatalog'
import { nativeDataAllowed } from './native/dataPolicy'
import { resumeCollaborationServer } from './collaboration/server'

const nativeRuntime = process.env.BLINKY_NATIVE_RUNTIME === '1'
const routineRunner = process.argv.includes('--routine-runner') && !nativeRuntime

// The preview channel is embedded at packaging time, not inferred from the
// app's filename: users can rename or move a bundle in Finder.
let preview = false
if (app.isPackaged) {
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { blinkyBuildChannel?: string }
    preview = metadata.blinkyBuildChannel === 'preview'
  } catch (error) {
    console.error('[blinky] could not read packaged app metadata', error)
    app.exit(1)
    throw error
  }
}
let nativeData = ''
if (nativeRuntime) {
  const supplied = process.env.BLINKY_NATIVE_DATA_DIR
  if (!supplied || !isAbsolute(supplied)) throw new Error('Native runtime requires an absolute data directory')
  const previewPath = app.isPackaged && preview ? join(app.getPath('appData'), 'BlinkyBot Preview') : undefined
  // Only the exact, known Preview location may be created automatically.
  if (previewPath && supplied === previewPath) mkdirSync(previewPath, { recursive: true })
  nativeData = realpathSync(supplied)
  // Do not follow a Preview directory symlink into the formal store.
  const realPreview = previewPath && supplied === previewPath
    ? join(realpathSync(app.getPath('appData')), 'BlinkyBot Preview')
    : undefined
  if (!nativeDataAllowed(nativeData, realpathSync(tmpdir()), realPreview)) {
    throw new Error('Native runtime data must be an isolated temporary directory or the packaged Preview store')
  }
}
app.setName(nativeRuntime && !(app.isPackaged && preview) ? 'Blinky Native Runtime' : preview ? 'BlinkyBot Preview' : 'BlinkyBot')
if (nativeRuntime) {
  app.setPath('userData', nativeData)
  process.env.OPENBOT_DATA_DIR = nativeData
} else if (preview) {
  // Set both paths before requesting the single-instance lock or loading data.
  // Do not inherit a production store override from the launch environment.
  const previewData = join(app.getPath('appData'), 'BlinkyBot Preview')
  app.setPath('userData', previewData)
  process.env.OPENBOT_DATA_DIR = process.env.BLINKY_SMOKE === '1' && process.env.BLINKY_SMOKE_DIR
    ? process.env.BLINKY_SMOKE_DIR
    : previewData
}
prepareShots()
prepareSmoke()
app.setAboutPanelOptions({
  applicationName: app.getName(),
  applicationVersion: app.getVersion(),
  copyright: 'BlinkyBot. Licensed under the MIT License.',
  credits:
    'BlinkyBot is an MIT fork of OpenBOT (https://github.com/ashhart/OpenBot). It is not affiliated with or endorsed by the OpenBOT authors.'
})

if (!claimSingleInstance()) {
  app.quit()
} else {
  installSecurity()
  if (!nativeRuntime) installLifecycle()

  app
    .whenReady()
    .then(async () => {
      await initStore({ background: routineRunner })
      if (routineRunner && (settingsAreUnreadable() || !getSettings().runRoutinesWhenClosed)) {
        if (!preview && !nativeRuntime) installRoutineLauncher()
        app.quit()
        return
      }
      installQueueRuntime()
      void recoverMemoryExtractions().catch((error) => console.error('[openbot/memory] recovery failed', error))
      installTaskInbox()
      installTaskProgressMonitor()
      installSemanticMemory()
      installTelemetry()
      app.once('before-quit', stopTaskProgressMonitor)
      installGitHubDraftInbox()
      installGmailDraftInbox()
      installCalendarDraftInbox()
      installXDraftInbox()
      installSlackDraftInbox()
      if (!nativeRuntime) { installSlackInbox(); installSlackSocket(); app.once('before-quit', stopSlackSocket); installWebhookDelivery(); installWebhookService(); app.once('before-quit', () => { stopWebhookDelivery(); stopWebhookService() }) }
      if (!preview && !nativeRuntime) { installBackgroundMode(); installRoutineLauncher() }
      installWindowChrome()
      registerIpc()
      if (!nativeRuntime && !routineRunner) await resumeCollaborationServer()
      if (nativeRuntime) {
        registerNativeHandler('native:catalog:providers', () => PROVIDER_CATALOG.map(({ id, label, baseUrl, protocol }) => ({ id, label, baseUrl, protocol })))
        startNativeBridge(() => {
          void stopChildProcesses().then(() => flushStore()).finally(() => app.exit(0))
        })
      } else {
        installMenu()
        if (!routineRunner && !app.getLoginItemSettings().wasOpenedAsHidden) createWindow()
        if (routineRunner) {
          if (process.platform === 'darwin') app.dock?.hide()
          installRunnerIdleExit()
          markSmokeReady()
        }
        startRoutineScheduler()
      }
      if (!nativeRuntime && !routineRunner && !botsLoadWasIncomplete()) {
        const managedTargets = listBots().flatMap((bot) =>
          bot.computerTarget.kind === 'vm' && bot.computerTarget.managed === 'apple-vm'
            ? [{ botId: bot.id, target: bot.computerTarget }]
            : []
        )
        const liveManagedBoxes = new Set(
          managedTargets.map(({ target }) => target.vmId)
        )
        // The private loopback bridge is deliberately process-owned. Rebuild
        // it for every persisted managed bot after an app restart; tools also
        // restore it lazily in case this background check has not finished.
        void Promise.all(
          managedTargets.map(({ botId, target }) =>
            startAppleVm(target, undefined, vmToken(botId)).catch((error) =>
              console.warn('[openbot/vm] could not restore managed VM bridge', target.vmId, error)
            )
          )
        )
        void cleanupOrphanedAppleVms(liveManagedBoxes).catch((error) =>
          console.warn('[openbot/vm] orphan cleanup failed', error)
        )
      } else if (!nativeRuntime && !routineRunner) {
        console.warn('[openbot/vm] skipped orphan cleanup because one or more bot documents are unreadable')
      }
    })
    .catch((err) => {
      console.error('[openbot] startup failed', err)
      markSmokeFailed(err)
      app.quit()
    })
}
