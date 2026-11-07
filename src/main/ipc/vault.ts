import type { VaultInput, VaultItem, VaultResult, VaultUpdate } from '../../shared/vault'
import { addVaultItem, updateVaultItem, listVaultItems, removeVaultItem, useVaultField } from '../store/vault'
import { runningSessionIds } from '../agent/cancel'
import { isStarting } from '../agent/startReservation'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { dataRoot } from '../store/paths'
import { getComputerProvider } from '../tools/computer'
import { handleEvent } from './handler'

/** Do not expose vault channels on the native agent bridge or log input values. */
export function registerVaultIpc(): void {
  handleEvent<VaultResult<VaultItem[]>>('openbot:vault:list', async () => {
    try { return { ok: true, value: await listVaultItems() } } catch { return { ok: false, error: 'The vault could not be read.' } }
  }, () => ({ ok: false, error: 'The vault could not be read.' }))
  handleEvent<VaultResult<VaultItem>>('openbot:vault:add', async (_event, [raw]) => {
    try { return { ok: true, value: await addVaultItem(raw as VaultInput) } } catch { return { ok: false, error: 'The item could not be securely saved. Check the fields and system encryption.' } }
  }, () => ({ ok: false, error: 'The item could not be securely saved.' }))
  handleEvent<VaultResult<VaultItem>>('openbot:vault:update', async (_event, [id, raw]) => {
    try {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid id')
      return { ok: true, value: await updateVaultItem(id, raw as VaultUpdate) }
    } catch { return { ok: false, error: 'The item could not be securely updated.' } }
  }, () => ({ ok: false, error: 'The item could not be securely updated.' }))
  handleEvent<VaultResult<boolean>>('openbot:vault:remove', async (_event, [raw]) => {
    try {
      if (typeof raw !== 'string' || !/^[a-f0-9-]{36}$/.test(raw)) throw new Error('invalid id')
      return { ok: true, value: await removeVaultItem(raw) }
    } catch { return { ok: false, error: 'The item could not be removed.' } }
  }, () => ({ ok: false, error: 'The item could not be removed.' }))
  // The renderer can request a user-initiated fill, but never receives values.
  // No channel is registered on the native agent bridge.
  handleEvent<VaultResult<boolean>>('openbot:vault:fill', async (_event, [botId, sessionId, itemId, field]) => {
    try {
      if (typeof botId !== 'string' || typeof sessionId !== 'string' || typeof itemId !== 'string' || !/^[a-f0-9-]{36}$/.test(itemId) || typeof field !== 'string' || field.length > 40) throw new Error('Invalid request.')
      const bot = getBot(botId), session = getSession(sessionId)
      if (!bot || bot.computerTarget.kind !== 'browser' || !session || session.activeBotId !== botId || isStarting(sessionId) || runningSessionIds().some((id) => getSession(id)?.botIds.includes(botId))) throw new Error('Stop the Bot before filling.')
      const provider = getComputerProvider(bot.computerTarget, { botId, sessionId, dataDir: dataRoot() }) as { fillVaultField?: (origin: string, field: string, value: string) => Promise<boolean> }
      if (!provider.fillVaultField) throw new Error('This browser cannot fill vault fields.')
      const filled = await useVaultField(itemId, field, async (origin, value) => {
        if (isStarting(sessionId) || runningSessionIds().some((id) => getSession(id)?.botIds.includes(botId))) return false
        return provider.fillVaultField!(origin, field, value)
      })
      return { ok: true, value: filled }
    } catch { return { ok: false, error: 'Could not fill. Check the saved website, the focused field and whether the Bot is stopped.' } }
  }, () => ({ ok: false, error: 'Could not fill the field.' }))
}
