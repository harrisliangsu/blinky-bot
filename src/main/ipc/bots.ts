/** IPC for `OpenBotApi.bots`, including per-bot memory. */

import type { Bot, BotSaveResult, MemoryEntry } from '../../shared/types'
import {
  createBot,
  duplicateBot,
  getBot,
  listBots,
  removeBotDurable,
  retryBotRemoval,
  setVmCapabilityProbe,
  updateBot
} from '../store/bots'
import { listBotMemory } from '../store/memory'
import { deleteUserMemory, saveUserMemory } from './memory'
import { removeBotFromProjects } from '../store/projects'
import { removeBotFromGroups } from '../store/groups'
import { removeRoutinesForBot } from '../store/routines'
import { allSessions, removeBotFromAllSessions } from '../store/sessions'
import { dataRoot } from '../store/paths'
import { clearVmToken } from '../store/vmSecrets'
import { loopFn } from './agentRuntime'
import { releaseComputerProvidersForBot } from '../tools/computer'
import { peekBrowserScopeMode } from '../tools/computer/browserScope'
import { removeBrowser } from '../tools/computer/browser'
import { adoptAppleVm, destroyAppleVm, provisionalAppleVmToken } from '../vm/appleVmSupervisor'
import { asComputerTarget, probeTarget } from './botComputerTarget'
import { forgetReadyTakeover, registerTakeoverIpc } from './botTakeover'
import { registerVmProvisionIpc } from './botVmProvision'
import { registerBotResourcesIpc } from './botResources'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleEvent, nullResult } from './handler'
import { asId, asPatch, asString } from './validate'

async function removeBotEverywhere(botId: string): Promise<void> {
  const bot = getBot(botId)
  if (!bot) return
  await retryBotRemoval(botId)
  const { prepareBotTaskRemoval } = await import('../tasks')
  const release = await prepareBotTaskRemoval(botId)
  try {
    forgetReadyTakeover(botId)

    const affectedSessions = allSessions().filter(
      (session) => session.botIds.includes(botId) || session.activeBotId === botId
    )
    const stop = await loopFn('stopSession')
    if (!stop && affectedSessions.length) throw new Error('The agent runtime must be available before deleting this bot.')
    if (stop) {
      await Promise.all(
        affectedSessions.map((session) => Promise.resolve(stop(session.id)))
      )
    }

    // Deleting a Bot is not permission to destroy its working computer or
    // signed-in browser data. Release live handles; retain persistent storage.
    await releaseComputerProvidersForBot(botId).catch((error) =>
      console.warn('[openbot/bots] could not release a computer provider', botId, error)
    )
    await removeBrowser(botId, { userDataDir: dataRoot() }).catch((error) =>
      console.warn('[openbot/bots] could not release a browser', botId, error)
    )
    if (await removeBotDurable(botId)) {
      removeRoutinesForBot(botId)
      removeBotFromGroups(botId)
      removeBotFromProjects(botId)
      const sessions = removeBotFromAllSessions(botId)
      for (const session of sessions) broadcast({ type: 'session-updated', session })
    }
  } finally { release() }
}


export function registerBotIpc(): void {
  registerBotResourcesIpc()
  /*
   * Capabilities read out of `bots/<id>.json` prove nothing — they are the
   * record of a probe, not evidence of one — so the store drops them on load
   * and asks for this before tool routing will honour a VM again. It lives on
   * this side because probing a managed box means starting it first and
   * unlocking its credential, both of which are this module's business.
   */
  setVmCapabilityProbe(async (bot) => {
    if (bot.computerTarget.kind !== 'vm') return null
    const probe = await probeTarget(bot.computerTarget, bot.id)
    return probe.ok ? (probe.capabilities ?? []) : null
  })

  handle<Bot[]>(CHANNELS.botsList, () => listBots(), emptyArray)

  handle<Bot | null>(CHANNELS.botsGet, ([id]) => getBot(asId(id)), nullResult)
  handle<{ mode: 'legacy' | 'session' } | { error: string }>(CHANNELS.botsBrowserScope, ([id]) => {
    const botId = asId(id)
    if (!getBot(botId)) return { error: 'Bot not found.' }
    return { mode: peekBrowserScopeMode(botId, dataRoot()) }
  }, () => ({ error: 'Browser scope is unavailable.' }))

  handle<BotSaveResult>(CHANNELS.botsDuplicate, ([id]) => {
    const bot = duplicateBot(asId(id))
    return bot ? { ok: true, bot } : { ok: false, error: 'That bot no longer exists.' }
  }, (_args, error) => ({ ok: false, error: error instanceof Error ? error.message : 'The bot could not be duplicated.' }))

  handle<BotSaveResult>(
    CHANNELS.botsCreate,
    async ([partial]) => {
      const changes = asPatch<Bot>(partial)
      if (changes.computerTarget !== undefined) {
        const target = asComputerTarget(changes.computerTarget)
        changes.computerTarget = target
        if (target.kind === 'vm') {
          const probe = await probeTarget(target)
          if (!probe.ok) return { ok: false, error: probe.detail ?? 'The VM is not ready.' }
          target.capabilities = probe.capabilities ?? []
          if (target.managed === 'apple-vm') {
            const credential = provisionalAppleVmToken(target.vmId)
            if (credential) target.token = credential
          }
        }
      }
      const created = createBot(changes)
      if (created.computerTarget.kind === 'vm' && created.computerTarget.managed === 'apple-vm') {
        adoptAppleVm(created.computerTarget.vmId)
      }
      return { ok: true, bot: created }
    },
    (_args, error) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'The bot could not be created.'
    })
  )

  registerVmProvisionIpc()
  registerTakeoverIpc()

  handle<BotSaveResult>(
    CHANNELS.botsUpdate,
    async ([id, patch]) => {
      const botId = asId(id)
      const before = getBot(botId)
      if (!before) return { ok: false, error: `Unknown bot: ${botId}` }
      const changes = asPatch<Bot>(patch)
      if (changes.computerTarget !== undefined) {
        const target = asComputerTarget(changes.computerTarget)
        changes.computerTarget = target
        if (target.kind === 'vm') {
          const probe = await probeTarget(target, botId)
          if (!probe.ok) return { ok: false, error: probe.detail ?? 'The VM is not ready.' }
          target.capabilities = probe.capabilities ?? []
          if (target.managed === 'apple-vm') {
            const credential = provisionalAppleVmToken(target.vmId)
            if (credential) target.token = credential
          }
        }
      }
      const updated = updateBot(botId, changes)
      if (!updated) return { ok: false, error: `Bot ${botId} could not be updated.` }
      if (updated.computerTarget.kind === 'vm' && updated.computerTarget.managed === 'apple-vm') {
        adoptAppleVm(updated.computerTarget.vmId)
      }
      const oldTarget = before?.computerTarget
      const newTarget = updated.computerTarget
      const targetChanged = JSON.stringify(oldTarget) !== JSON.stringify(newTarget)
      if (targetChanged || Object.hasOwn(changes.computerTarget ?? {}, 'token')) {
        forgetReadyTakeover(botId)
        await releaseComputerProvidersForBot(botId)
      }
      if (oldTarget?.kind === 'vm' && newTarget.kind !== 'vm') clearVmToken(botId)
      if (
        oldTarget?.kind === 'vm' &&
        oldTarget.managed === 'apple-vm' &&
        (newTarget.kind !== 'vm' || newTarget.vmId !== oldTarget.vmId)
      ) {
        await destroyAppleVm(oldTarget).catch((error) =>
          console.warn('[openbot/bots] replaced managed VM could not be destroyed', oldTarget.vmId, error)
        )
      }
      return { ok: true, bot: updated }
    },
    (_args, error) => ({
      ok: false,
      error: error instanceof Error ? error.message : 'The bot could not be updated.'
    })
  )

  handle<{ ok: true } | { ok: false; error: string }>(CHANNELS.botsRemove, async ([id]) => {
    await removeBotEverywhere(asId(id))
    return { ok: true }
  }, () => ({ ok: false, error: 'Bot 删除未能完成，会话记录保留。请重试。' }))

  handle<MemoryEntry[]>(CHANNELS.botsMemory, ([id]) => listBotMemory(asId(id)), emptyArray)

  handleEvent<MemoryEntry | null>(
    CHANNELS.botsAddMemory,
    (_event, [id, request]) => saveUserMemory(id, request),
    nullResult
  )

  handleEvent<boolean>(CHANNELS.botsRemoveMemory, (_event, [id, entryId]) => deleteUserMemory(id, entryId), () => false)
}
