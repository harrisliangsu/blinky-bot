/**
 * OpenBOT main process entry.
 *
 * Boot order matters: storage first (settings feed bot seeding), then the IPC
 * surface, then the menu and window — so the renderer never sees a channel
 * that is not yet registered.
 */

import { app } from 'electron'
import { installBackgroundMode, installLifecycle, claimSingleInstance } from './app/lifecycle'
import { installMenu } from './app/menu'
import { installSecurity } from './app/security'
import { createWindow } from './app/window'
import { registerIpc } from './ipc'
import { initStore } from './store'
import { startRoutineScheduler } from './routines/scheduler'
import { botsLoadWasIncomplete, listBots } from './store/bots'
import { vmToken } from './store/vmSecrets'
import { cleanupOrphanedAppleVms, startAppleVm } from './vm/appleVmSupervisor'

app.setName('BlinkyBot')
app.setAboutPanelOptions({
  applicationName: 'BlinkyBot',
  applicationVersion: app.getVersion(),
  copyright: 'BlinkyBot. Licensed under the MIT License.',
  credits:
    'BlinkyBot is an MIT fork of OpenBOT (https://github.com/ashhart/OpenBot). It is not affiliated with or endorsed by the OpenBOT authors.'
})

if (!claimSingleInstance()) {
  app.quit()
} else {
  installSecurity()
  installLifecycle()

  app
    .whenReady()
    .then(async () => {
      await initStore()
      installBackgroundMode()
      registerIpc()
      installMenu()
      if (!app.getLoginItemSettings().wasOpenedAsHidden) createWindow()
      startRoutineScheduler()
      if (!botsLoadWasIncomplete()) {
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
      } else {
        console.warn('[openbot/vm] skipped orphan cleanup because one or more bot documents are unreadable')
      }
    })
    .catch((err) => {
      console.error('[openbot] startup failed', err)
      app.quit()
    })
}
