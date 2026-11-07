import { CONNECTED_APP_TOOLS, type ConnectedApp } from '../../shared/connectedAppTools'
import { botToolsRevision, getBot, setBotAppToolsDurable } from '../store/bots'
import { publishDesktopEvent } from '../ipc/eventBus'
export interface AppToolIntent { service: ConnectedApp; botId: string; revision: number; epoch: number }
const epochs = new Map<ConnectedApp, number>()
export function invalidateAppToolIntent(service: ConnectedApp): void { epochs.set(service, (epochs.get(service) ?? 0) + 1) }
export function captureAppToolIntent(service: ConnectedApp, value: unknown): AppToolIntent | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 160) throw new Error('Choose a Bot for this app.')
  const bot = getBot(value)
  if (!bot || bot.archived || bot.computerTarget.kind === 'vm') throw new Error('Choose an active Bot that uses this Mac’s apps.')
  return { service, botId: bot.id, revision: botToolsRevision(bot.id), epoch: epochs.get(service) ?? 0 }
}
export async function finishAppToolIntent(intent: AppToolIntent | undefined, enabled = true) {
  if (!intent) return undefined
  const bot = await setBotAppToolsDurable(intent.botId, CONNECTED_APP_TOOLS[intent.service], enabled, enabled ? intent.revision : undefined, () => (epochs.get(intent.service) ?? 0) === intent.epoch)
  publishDesktopEvent({ type: 'workspace-updated', area: 'bots' })
  return bot
}
