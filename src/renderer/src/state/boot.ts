import { errText, tryBridge } from './bridge'
import { loadSkills } from './skills'
import { loadBots } from './bots'
import { store } from './core'
import { applyEvent } from './events'
import { loadBackends, loadSettings } from './preferences'
import { loadProjects } from './projects'
import { loadRoutines } from './routines'
import { loadSessions, openBotChat, selectSession } from './sessions'
import { loadActivity } from './activity'
import { loadGroups } from './groups'
import { loadRooms } from './rooms'

let started = false
let detach: (() => void) | null = null

const NO_BRIDGE =
  'The agent bridge is unavailable, so the interface cannot reach the agent process. Restart the app; if it keeps happening the preload script failed to load.'

/** Subscribes to the event stream and pulls the first snapshot of everything. */
export async function boot(): Promise<void> {
  if (started) return
  started = true

  const api = tryBridge()
  if (!api) {
    store.patch({ ready: true, bootError: NO_BRIDGE, sessionsLoading: false, backendsLoading: false })
    return
  }

  // Nothing below may leave the app on the startup screen: an unhandled
  // rejection here is indistinguishable from a hang the user cannot escape.
  try {
    detach = api.on(applyEvent)

    await Promise.all([loadSettings(), loadBots(), loadGroups(), loadRooms(), loadSkills(), loadBackends(false), loadRoutines(), loadProjects(), loadSessions(), loadActivity()])

    const firstBot = store.getState().bots.find((bot) => !bot.archived)
    const initial = api.environment?.kind === 'browser' ? api.environment.initialSessionId : undefined
    if (initial && store.getState().sessions.some(session => session.id === initial)) await selectSession(initial)
    else if (firstBot) await openBotChat(firstBot.id)

    store.patch({ ready: true })
    // First paint uses the persisted backend cache. Refresh the machine probes
    // after the UI is usable instead of holding the whole app on the splash.
    void loadBackends(true)
  } catch (e) {
    store.patch({ ready: true, bootError: errText(e), sessionsLoading: false, backendsLoading: false })
  }
}

/** Only used when the renderer tears down; hot reload keeps the subscription. */
export function shutdown(): void {
  detach?.()
  detach = null
  started = false
}
