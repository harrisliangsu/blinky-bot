import type {
  Bot,
  ComputerProbeResult,
  ComputerTarget,
  HumanComputerAction,
  VmAdminResult,
  VmProvisionStatus
} from '../../../shared/types'
import { bridge, errText } from './bridge'
import { store } from './core'

export async function loadBots(): Promise<void> {
  try {
    store.patch({ bots: await bridge().bots.list(), botsError: null })
  } catch (e) {
    store.patch({ botsError: errText(e) })
  }
}

export async function createBot(partial: Partial<Bot>): Promise<Bot | null> {
  try {
    const result = await bridge().bots.create(partial)
    if (!result.ok) {
      store.toast(result.error, 'error')
      return null
    }
    store.patch({ bots: [...store.getState().bots, result.bot] })
    return result.bot
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

export async function updateBot(id: string, patch: Partial<Bot>): Promise<Bot | null> {
  try {
    const result = await bridge().bots.update(id, patch)
    if (!result.ok) {
      store.toast(result.error, 'error')
      return null
    }
    store.patch({ bots: store.getState().bots.map((b) => (b.id === id ? result.bot : b)) })
    return result.bot
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

export async function duplicateBot(id: string): Promise<Bot | null> {
  try {
    const result = await bridge().bots.duplicate(id)
    if (!result.ok) { store.toast(result.error, 'error'); return null }
    store.patch({ bots: [...store.getState().bots, result.bot] })
    return result.bot
  } catch (error) { store.toast(errText(error), 'error'); return null }
}

export async function probeComputerTarget(
  target: ComputerTarget,
  botId?: string
): Promise<ComputerProbeResult> {
  try {
    return await bridge().bots.probeTarget(target, botId)
  } catch (e) {
    return { ok: false, detail: errText(e) }
  }
}

export async function provisionComputerTarget(): Promise<Extract<ComputerTarget, { kind: 'vm' }> | null> {
  try {
    const result = await bridge().bots.provisionTarget()
    if (!result.ok) {
      store.toast(result.error, 'error')
      return null
    }
    store.toast(result.detail)
    return result.target
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

export async function computerProvisionStatus(): Promise<VmProvisionStatus> {
  try {
    return await bridge().bots.provisionStatus()
  } catch (error) {
    return {
      active: false,
      stage: 'failed',
      detail: errText(error),
      updatedAt: Date.now()
    }
  }
}

export async function cancelComputerProvision(): Promise<VmProvisionStatus> {
  try {
    return await bridge().bots.cancelProvision()
  } catch (error) {
    const detail = errText(error)
    store.toast(detail, 'error')
    return { active: false, stage: 'failed', detail, updatedAt: Date.now() }
  }
}

export async function captureBotScreen(
  botId: string,
  options: { quiet?: boolean; sessionId?: string } = {}
): Promise<boolean> {
  try {
    const sessionId = options.sessionId ?? store.getState().currentSessionId ?? undefined
    const frame = await bridge().bots.captureScreen(botId, sessionId)
    if (!frame.ok) throw new Error(frame.error)
    if (store.getState().currentSessionId !== sessionId) return false
    store.patch({
      computerFrame: { screenshot: frame.frame.image, at: Date.now(), botId, sessionId: sessionId ?? null }
    })
    return true
  } catch (error) {
    if (!options.quiet) store.toast(errText(error), 'error')
    return false
  }
}

export async function controlBotScreen(botId: string, action: HumanComputerAction, sessionId = store.getState().currentSessionId ?? undefined): Promise<void> {
  try {
    const frame = await bridge().bots.controlScreen(botId, action, sessionId)
    if (!frame.ok) throw new Error(frame.error)
    if (store.getState().currentSessionId !== sessionId) return
    store.patch({
      computerFrame: { screenshot: frame.frame.image, at: Date.now(), botId, sessionId: sessionId ?? null },
      computerActive: false
    })
  } catch (error) {
    store.toast(errText(error), 'error')
  }
}

/** Human-only administrative shell; this is never exposed as a model tool. */
export async function runBotAdminCommand(botId: string, command: string): Promise<VmAdminResult> {
  try {
    return await bridge().bots.runAdminCommand(botId, command)
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

export async function restartBotComputer(botId: string): Promise<boolean> {
  try {
    const result = await bridge().bots.restartTarget(botId)
    if (!result.ok) throw new Error(result.detail ?? 'The managed VM did not restart.')
    store.patch({ computerFrame: null, computerActive: false })
    store.toast('Private VM restarted. Its files and signed-in profile were preserved.')
    return true
  } catch (error) {
    store.toast(errText(error), 'error')
    return false
  }
}

export async function discardComputerTarget(target: ComputerTarget): Promise<void> {
  if (target.kind !== 'vm' || target.managed !== 'apple-vm') return
  try {
    await bridge().bots.discardTarget(target)
  } catch (error) {
    store.toast(errText(error), 'error')
  }
}

/**
 * Answers whether the bot actually went.
 *
 * The editor closes itself on the way out, and only a delete that succeeded may
 * close it: a failed one has toasted and the bot is still there to try again.
 */
export async function removeBot(id: string): Promise<boolean> {
  try {
    const result = await bridge().bots.remove(id)
    if (!result?.ok) {
      store.toast(result?.error ?? 'Bot 删除未能完成，请重试。', 'error')
      return false
    }
    store.patch({ bots: store.getState().bots.filter((b) => b.id !== id), botDraftId: null })
    return true
  } catch (e) {
    store.toast(errText(e), 'error')
    return false
  }
}

export async function loadMemory(botId: string): Promise<void> {
  try {
    const entries = await bridge().bots.memory(botId)
    store.patch({ memories: { ...store.getState().memories, [botId]: entries } })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function addMemory(botId: string, text: string): Promise<boolean> {
  const body = text.trim()
  if (!body) return false
  try {
    const entry = await bridge().bots.addMemory(botId, body)
    if (!entry) { store.toast(store.getState().settings?.language === 'zh-CN' ? '记忆未能保存，请检查本地存储。' : 'Memory could not be saved. Check local storage.', 'error'); return false }
    const list = store.getState().memories[botId] ?? []
    /*
     * The main process broadcasts `memory-updated` for this same entry, and the
     * reply and the broadcast are separate channels — either can land first. So
     * both paths check the id before prepending; without it the typed fact was
     * listed twice, two rows carrying one id, and forgetting either removed both.
     * A write that failed comes back as a blank-id placeholder, and blank ids
     * must not be read as matching one another.
     */
    if (entry.id && list.some((existing) => existing.id === entry.id)) return true
    store.patch({ memories: { ...store.getState().memories, [botId]: [entry, ...list] } })
    return true
  } catch (e) {
    store.toast(errText(e), 'error')
    return false
  }
}

export async function removeMemory(botId: string, entryId: string): Promise<void> {
  try {
    await bridge().bots.removeMemory(botId, entryId)
    const list = store.getState().memories[botId] ?? []
    store.patch({ memories: { ...store.getState().memories, [botId]: list.filter((m) => m.id !== entryId) } })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}
