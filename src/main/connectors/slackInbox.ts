import { onAgentEvent } from '../agent/events'
import { announceQueue, drainQueue, isQueueSuspended } from '../agent/messageQueueRuntime'
import { beginQueueWrite, endQueueWrite } from '../agent/startReservation'
import { getBot } from '../store/bots'
import { ensureBotHome } from '../store/botHome'
import { flushAll } from '../store/jsonStore'
import { enqueueExternalMessageOnce, getMessageQueue } from '../store/messageQueue'
import { getSession } from '../store/sessions'
import { markSlackQueued, pendingSlackEvents } from './slackInboxStore'
import { readSlackCredentials } from './slackSecrets'

let installed = false, draining = false, needsAnotherPass = false
export function installSlackInbox(): void {
  if (installed) return
  installed = true
  onAgentEvent((event) => { if (event.type === 'done' || event.type === 'session-updated') void drainSlackInbox() })
  void drainSlackInbox()
}
export async function drainSlackInbox(): Promise<void> {
  if (draining) { needsAnotherPass = true; return }
  draining = true
  try {
    const config = await readSlackCredentials(); if (!config || config.oauth) return
    for (const item of await pendingSlackEvents()) {
      // Reconfiguration or disconnect must not reroute already accepted input.
      if (item.teamId !== config.teamId || item.channelId !== config.channelId || item.userId !== config.allowedUserId || item.botId !== config.botId) continue
      const bot = getBot(item.botId); if (!bot || bot.archived) continue
      const session = ensureBotHome(item.botId)
      if (!session || session.botIds.length !== 1 || session.botIds[0] !== item.botId || session.activeBotId !== item.botId) continue
      const saved = await flushAll(); if (saved.failed.length || saved.stillWriting) throw new Error('The destination conversation could not be saved.')
      const current = getSession(session.id)
      if (!current || current.archived || current.activeBotId !== item.botId || current.botIds.length !== 1 || current.botIds[0] !== item.botId) continue
      const text = `[Slack ${item.channelId} · ${item.userId} · ${item.ts}]\n${item.text}`
      beginQueueWrite(session.id)
      try {
        if (!getSession(session.id)?.messages.some((message) => message.id === item.id) && !getMessageQueue(session.id).items.some((queued) => queued.id === item.id)) await enqueueExternalMessageOnce(session.id, item.id, text, item.botId, isQueueSuspended(session.id))
        await markSlackQueued(item.id, session.id)
        announceQueue(session.id)
      } finally { endQueueWrite(session.id); void drainQueue(session.id) }
    }
  } catch { console.error('[slack inbox] pending messages could not be delivered safely') }
  finally { draining = false; if (needsAnotherPass) { needsAnotherPass = false; void drainSlackInbox() } }
}
