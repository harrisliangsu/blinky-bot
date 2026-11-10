import { supportsFullAccessExecution } from '../../shared/executionAccess'
/**
 * Bots — personas with their own prompt, tools and memory.
 * One `bots/<id>.json` per bot; starter personas live in `starterBots.ts`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import { avatarFields } from '../../shared/botAvatars'
import { revokeExecutorAccess } from '../agent/executionAgent'
import { supportsExecutionDelegation } from '../../shared/executionAgentCapabilities'
import { join } from 'node:path'
import { resolveBotBinding, snapshotBotBinding, type BotBinding } from '../../shared/botBinding'
import { isThinkingDepth, type ThinkingDepth } from '../../shared/thinking'
import type { Bot, ComputerTarget } from '../../shared/types'
import { getSettings } from '../settings'
import { KNOWN_BACKEND_IDS, isCustomBackendId } from '../settingsSchema'
import { JsonCollection } from './collection'
import { revokeBotGrants } from '../gateway/tokens'
import { recordBotTools } from '../agent/botToolScope'
import { botsDir, safeFileName } from './paths'
import { deleteJson, reviveJson, writeJsonNow } from './jsonStore'
import { clearBotMemory } from './memory'
import { DEFAULT_BOT_TOOLS, LOCAL_TARGET, migrateSeededAssistant, starterBots } from './starterBots'
import { clearVmToken, hasVmToken, setVmToken } from './vmSecrets'

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * A bot saved against a backend that no longer exists — renamed, removed, or
 * from an older build — falls back to the current default rather than pointing
 * at nothing. The model slug is only meaningful beside its backend, so the two
 * are reset together.
 */
function resolveBackend(
  rawBackendId: unknown,
  rawModelId: unknown
): { backendId: string; modelId: string } {
  const settings = getSettings()
  const stored = typeof rawBackendId === 'string' ? rawBackendId : ''
  if (!stored || (!KNOWN_BACKEND_IDS.includes(stored) && !(isCustomBackendId(stored) && settings.backends[stored]))) {
    // Flagged so `loadBots` can write the correction back, otherwise the same
    // migration would silently re-run on every launch.
    retiredBackendSeen = true
    return { backendId: settings.defaultBackendId, modelId: settings.defaultModelId }
  }
  return {
    backendId: stored,
    modelId: typeof rawModelId === 'string' && rawModelId ? rawModelId : settings.defaultModelId
  }
}

/** Settings wins for unpinned Bots. A mismatch is written back on the next load. */
function alignBinding(
  rawBackendId: unknown,
  rawModelId: unknown,
  rawFollows: unknown,
  rawThinking: unknown
): BotBinding {
  const resolved = resolveBackend(rawBackendId, rawModelId)
  const followsDefault = rawFollows === false ? false : rawFollows === true ? true : undefined
  const storedThinking = isThinkingDepth(rawThinking) ? rawThinking : undefined
  const input =
    {
      backendId: resolved.backendId,
      modelId: resolved.modelId,
      ...(followsDefault === undefined ? {} : { followsDefault }),
      ...(storedThinking ? { thinking: storedThinking } : {})
    }
  const binding = followsDefault === false
    ? resolveBotBinding(input, getSettings())
    : snapshotBotBinding(input, getSettings())
  // A Bot that follows Settings does not keep its own depth on disk. The turn
  // reads the default again, so a later change in Settings still applies.
  const persistedThinking = binding.followsDefault ? undefined : binding.thinking
  const storedBackend = typeof rawBackendId === 'string' ? rawBackendId : ''
  const storedModel = typeof rawModelId === 'string' ? rawModelId : ''
  if (
    binding.backendId !== storedBackend ||
    binding.modelId !== storedModel ||
    rawFollows !== binding.followsDefault ||
    storedThinking !== persistedThinking
  ) {
    bindingAligned = true
  }
  return persistedThinking ? { ...binding, thinking: persistedThinking } : { ...binding, thinking: undefined }
}

/** Set during load when any bot referenced a backend this build dropped. */
let retiredBackendSeen = false
/** Set during load when a legacy bot carried a plaintext VM bearer token. */
let plaintextVmTokenSeen = false
/** Set during load when the seeded general-purpose bot was still named Assistant. */
let seededAssistantSeen = false
/** Set during load when a Bot's CLI binding did not match Settings. */
let bindingAligned = false

interface TargetOptions {
  /**
   * The target came from a live object or a fresh probe rather than off disk,
   * so the capabilities it carries are this process's own and may be kept.
   */
  probed: boolean
}

/** Preserve isolation targets; malformed isolated targets fail back to local. */
function normaliseTarget(value: unknown, botId: string, opts: TargetOptions): ComputerTarget {
  if (typeof value !== 'object' || value === null) return { ...LOCAL_TARGET }
  const source = value as Record<string, unknown>
  if (source['kind'] === 'browser') {
    // A profile is owned by this bot. Ignore a stored foreign botId so copying a
    // JSON document cannot make two bots share credentials and cookies.
    // Existing profiles belong to Chrome; preserve them when upgrading.
    return { kind: 'browser', botId, provider: source['provider'] === 'ego' ? 'ego' : 'chrome' }
  }
  if (source['kind'] !== 'vm') return { ...LOCAL_TARGET }
  const vmId = source['vmId']
  const endpoint = source['endpoint']
  if (typeof vmId !== 'string' || !vmId || typeof endpoint !== 'string' || !endpoint) {
    return { ...LOCAL_TARGET }
  }
  if (typeof source['token'] === 'string') {
    // Old builds persisted this credential inside the bot document. Move it to
    // safeStorage and never put the plaintext value back into the Bot object.
    try {
      setVmToken(botId, source['token'])
      plaintextVmTokenSeen = true
    } catch (error) {
      // Keep the original document untouched until the OS credential service
      // becomes available; failing the entire app startup would strand every bot.
      console.error('[openbot/store] could not migrate a legacy VM token', botId, error)
    }
  }
  const target: ComputerTarget = { kind: 'vm', vmId, endpoint }
  if (source['managed'] === 'apple-vm') target.managed = 'apple-vm'
  if (hasVmToken(botId)) target.hasToken = true
  // Capabilities are what the tool router consults to decide a call may run
  // inside the box, and the contract is that they are written down only after
  // an authenticated probe answered. A document read off disk carries no such
  // proof — a hand-edited `bots/<id>.json` can claim `box-exec-v1` for an
  // endpoint that has never replied — so the persisted list is dropped and
  // `verifyVmCapabilities` asks the VM itself before anything honours it.
  if (opts.probed && Array.isArray(source['capabilities'])) {
    target.capabilities = source['capabilities'].filter(
      (entry): entry is string => typeof entry === 'string' && entry.length <= 100
    ).slice(0, 32)
  }
  return target
}

function normaliseBot(raw: unknown, opts: TargetOptions = { probed: false }): Bot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = typeof value['id'] === 'string' ? value['id'] : ''
  if (!id) return null
  const now = Date.now()
  const bot: Bot = {
    id,
    name: typeof value['name'] === 'string' && value['name'] ? value['name'] : 'Untitled bot',
    description: typeof value['description'] === 'string' ? value['description'] : '',
    systemPrompt: typeof value['systemPrompt'] === 'string' ? value['systemPrompt'] : '',
    emoji: typeof value['emoji'] === 'string' && value['emoji'] ? value['emoji'] : '🤖',
    color: typeof value['color'] === 'string' && value['color'] ? value['color'] : '#7c9cff',
    ...avatarFields(value),
    ...bindingFields(alignBinding(value['backendId'], value['modelId'], value['followsDefault'], value['thinking'])),
    ...(value['fast'] === true ? { fast: true } : {}),
    tools: stringList(value['tools']),
    skills: stringList(value['skills']),
    ...(stringList(value['agentsMdIds']).length ? { agentsMdIds: stringList(value['agentsMdIds']) } : {}),
    computerUse: value['computerUse'] === true,
    computerTarget: normaliseTarget(value['computerTarget'], id, opts),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : now,
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : now
  }
  if (value['archived'] === true) bot.archived = true
  if (value['pinned'] === true) bot.pinned = true
  const execution = value['executionAgent']
  // The retired opt-out must neither block delegation nor survive a save.
  if (value['executionAgentDisabled'] !== undefined) bindingAligned = true
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const config = execution as Record<string, unknown>
    if (typeof config['backendId'] === 'string' && config['backendId'].trim() && typeof config['modelId'] === 'string' && config['modelId'].trim()) {
      bot.executionAgent = { backendId: config['backendId'].trim().slice(0, 200), modelId: config['modelId'].trim().slice(0, 200), ...(isThinkingDepth(config['thinking']) ? { thinking: config['thinking'] } : {}), ...(config['accessMode'] === 'full-access' && supportsFullAccessExecution(String(config['backendId']).trim()) ? { accessMode: 'full-access' as const } : {}) }
    }
  }
  // Legacy Bots with delegation enabled predate the independent executor
  // field. Pin the current Bot choice once; future edits are independent.
  if (!bot.executionAgent && (execution === undefined || value['executionAgentDisabled'] === true) && bot.tools.includes('delegate_task') && supportsExecutionDelegation(bot.backendId)) {
    bot.executionAgent = { backendId: bot.backendId, modelId: bot.modelId, ...(bot.thinking ? { thinking: bot.thinking } : {}) }
    bindingAligned = true
  }
  if (typeof value['activeConversationId'] === 'string' && value['activeConversationId']) bot.activeConversationId = value['activeConversationId']
  const renamed = migrateSeededAssistant(bot)
  if (!renamed) return bot
  seededAssistantSeen = true
  return { ...renamed, updatedAt: now }
}

const collection = new JsonCollection<Bot>(botsDir, (raw) => normaliseBot(raw))

/* ── VM capabilities: probed, never merely persisted ─────────────── */

/** Answers with the capabilities a VM advertises, or null if it did not. */
export type VmCapabilityProbe = (bot: Bot) => Promise<string[] | null>

let vmCapabilityProbe: VmCapabilityProbe | null = null
/** Bots whose VM answered a probe in this process. */
const probedVms = new Set<string>()
/** Probes in flight, so a burst of reads cannot start a stampede. */
const probingVms = new Set<string>()
/** When each bot was last asked, so a VM that is down is not hammered. */
const probedAt = new Map<string, number>()
const PROBE_RETRY_MS = 30_000

/**
 * Install the probe. The IPC layer owns it — it is the side that knows how to
 * start a managed VM and unlock its credential — and the store only knows that
 * a persisted capability list has to be re-earned before it counts.
 */
export function setVmCapabilityProbe(probe: VmCapabilityProbe): void {
  vmCapabilityProbe = probe
}

/**
 * Ask a VM what it can do, once per bot per session, in the background.
 *
 * Reads stay synchronous: until the answer arrives the bot simply has no
 * capabilities, and the router refuses a box-bound call rather than running it
 * anywhere else. A probe that fails is retried on the next read after the
 * cooldown, so a VM the user starts later still comes good without a restart.
 */
function verifyVmCapabilities(bot: Bot): void {
  if (bot.computerTarget.kind !== 'vm' || probedVms.has(bot.id)) return
  if (!vmCapabilityProbe || probingVms.has(bot.id)) return
  if (Date.now() - (probedAt.get(bot.id) ?? 0) < PROBE_RETRY_MS) return
  probedAt.set(bot.id, Date.now())
  probingVms.add(bot.id)
  void vmCapabilityProbe(bot)
    .then((capabilities) => {
      const current = collection.get(bot.id)
      // Deleted, or switched away from the VM, while the probe was in flight.
      if (!capabilities || !current || current.computerTarget.kind !== 'vm') return
      probedVms.add(bot.id)
      collection.put({
        ...current,
        computerTarget: { ...current.computerTarget, capabilities }
      })
    })
    .catch((error) => console.warn('[openbot/store] VM capability probe failed', bot.id, error))
    .finally(() => probingVms.delete(bot.id))
}

export async function loadBots(): Promise<void> {
  retiredBackendSeen = false
  plaintextVmTokenSeen = false
  seededAssistantSeen = false
  bindingAligned = false
  await collection.load()
  // Persist the normalised values so the migration happens exactly once.
  if (retiredBackendSeen || plaintextVmTokenSeen || seededAssistantSeen || bindingAligned) {
    // Persist before the settings window can change the defaults. Otherwise a
    // crash during the debounce could make the same legacy bot resolve to a
    // different backend on the next launch.
    await Promise.all(collection.all().map((bot) =>
      writeJsonNow(join(botsDir(), `${safeFileName(bot.id)}.json`), bot)))
  }
}

/**
 * Make the stored CLI and model match Settings, and return the Bot the turn
 * should run. A no-op when they already agree.
 */
/** Disk fields for a binding. Thinking is omitted when this Bot follows Settings. */
function bindingFields(binding: BotBinding): Pick<Bot, 'backendId' | 'modelId' | 'followsDefault' | 'thinking'> {
  return {
    backendId: binding.backendId,
    modelId: binding.modelId,
    followsDefault: binding.followsDefault,
    ...(binding.thinking ? { thinking: binding.thinking } : {})
  }
}

/** The Bot a turn should run. Settings fills in a Bot that follows the defaults. */
export function applyBotBinding(bot: Bot): Bot {
  const binding = resolveBotBinding(bot, getSettings())
  const persistedThinking = binding.followsDefault ? undefined : binding.thinking
  const same =
    bot.backendId === binding.backendId &&
    bot.modelId === binding.modelId &&
    bot.followsDefault === binding.followsDefault &&
    (bot.thinking ?? undefined) === persistedThinking
  const live = liveBot(bot, binding)
  if (same) return live
  // Empty string clears a depth. `undefined` is dropped by the merge, so a
  // Bot that starts following Settings would otherwise keep the old depth.
  const saved = updateBot(bot.id, {
    ...bindingFields({ ...binding, thinking: persistedThinking }),
    ...(!persistedThinking ? { thinking: '' as ThinkingDepth } : {})
  })
  return saved ? liveBot(saved, binding) : live
}

function liveBot(bot: Bot, binding: BotBinding): Bot {
  const live: Bot = { ...bot, ...bindingFields(binding.followsDefault ? { ...binding, thinking: undefined } : binding) }
  if (binding.thinking) live.thinking = binding.thinking
  else delete live.thinking
  return live
}

/** Point every Bot that follows Settings at the current default CLI and model. */
export function syncBotBindings(): void {
  for (const bot of listBots()) applyBotBinding(bot)
}

/** Orphan cleanup must stand down when an unreadable bot file may still own a box. */
export function botsLoadWasIncomplete(): boolean {
  return collection.loadWasIncomplete
}

/**
 * Every bot, oldest first, archived ones last.
 *
 * Also where an unverified VM gets asked to prove itself: this runs at startup
 * (the managed-VM restore reads it) and on every renderer refresh, and unlike
 * `getBot` it is never the accessor a deletion goes through — probing a box the
 * user just asked to destroy would start the very VM being torn down.
 */
export function listBots(): Bot[] {
  const bots = collection.all()
  for (const bot of bots) verifyVmCapabilities(bot)
  return bots.map(withConfirmedTools).sort((a, b) => {
    const archived = Number(a.archived ?? false) - Number(b.archived ?? false)
    if (archived !== 0) return archived
    const pinned = Number(b.pinned ?? false) - Number(a.pinned ?? false)
    return pinned !== 0 ? pinned : a.createdAt - b.createdAt
  })
}

export function getBot(id: string): Bot | null {
  const bot = collection.get(id)
  return bot ? withConfirmedTools(bot) : null
}

const toolRevisions = new Map<string, number>()
const pendingAppTools = new Map<string, Set<string>>()
const appToolWrites = new Map<string, Promise<unknown>>()
function withConfirmedTools(bot: Bot): Bot {
  const pending = pendingAppTools.get(bot.id), result = pending?.size ? { ...bot, tools: bot.tools.filter(id => !pending.has(id)) } : bot
  recordBotTools(bot.id, result.tools)
  return result
}
export const botToolsRevision = (id: string): number => toolRevisions.get(id) ?? 0

/** Main-process merge, not a renderer read/replace. New grants are hidden until durable. */
export function setBotAppToolsDurable(id: string, ids: readonly string[], enabled: boolean, expectedRevision?: number, allowed: () => boolean = () => true): Promise<Bot> {
  const operation = (appToolWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const before = collection.get(id)
    if (!before || before.archived || before.computerTarget.kind === 'vm') throw new Error('Choose an available Bot that uses this Mac’s app connection.')
    if (!allowed() || expectedRevision !== undefined && botToolsRevision(id) !== expectedRevision) throw new Error('The connection or Bot permissions changed. Review and allow this Bot again.')
    const requested = new Set(ids), added = enabled ? ids.filter(tool => !before.tools.includes(tool)) : []
    pendingAppTools.set(id, new Set(added))
    try {
      updateBot(id, { tools: enabled ? [...new Set([...before.tools, ...ids])] : before.tools.filter(tool => !requested.has(tool)) })
      const revision = botToolsRevision(id)
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = collection.get(id)
        if (!current || !allowed() || botToolsRevision(id) !== revision) throw new Error('The connection or Bot permissions changed while saving. No new app tools were enabled.')
        await writeJsonNow(join(botsDir(), safeFileName(id) + '.json'), current)
        if (!allowed() || botToolsRevision(id) !== revision) throw new Error('The connection or Bot permissions changed while saving. No new app tools were enabled.')
        if (collection.get(id) === current) { pendingAppTools.delete(id); return withConfirmedTools(current) }
      }
      throw new Error('The Bot is still being edited. App access was not saved; try again.')
    } catch (error) {
      // Roll back only newly added capabilities, preserving every concurrent
      // edit. A failed withdrawal stays withdrawn in this process.
      const current = collection.get(id)
      if (current && added.length) {
        updateBot(id, { tools: current.tools.filter(tool => !added.includes(tool)) })
        const restored = collection.get(id)
        if (restored) await writeJsonNow(join(botsDir(), safeFileName(id) + '.json'), restored).catch(() => {})
      }
      throw error
    } finally { pendingAppTools.delete(id) }
  })
  appToolWrites.set(id, operation)
  void operation.finally(() => { if (appToolWrites.get(id) === operation) appToolWrites.delete(id) }).catch(() => {})
  return operation
}

/** The bot a new session defaults to. */
export function defaultBotId(): string {
  return listBots().find((bot) => !bot.archived)?.id ?? ''
}

function pinnedBinding(partial: Partial<Bot>, settings: ReturnType<typeof getSettings>): BotBinding {
  const followsDefault =
    partial.followsDefault === false ? false : partial.followsDefault === true ? true : !partial.backendId
  const thinking = isThinkingDepth(partial.thinking) ? partial.thinking : undefined
  const binding = resolveBotBinding(
    {
      backendId: partial.backendId || settings.defaultBackendId,
      modelId: partial.modelId || settings.defaultModelId,
      followsDefault,
      ...(thinking ? { thinking } : {})
    },
    settings
  )
  return binding.followsDefault ? snapshotBotBinding({ backendId: binding.backendId, modelId: binding.modelId, followsDefault: true }, settings) : binding
}

export function createBot(partial: Partial<Bot> = {}): Bot {
  const settings = getSettings()
  const now = Date.now()
  const id = randomUUID()
  const bot: Bot = {
    id,
    name: partial.name?.trim() || 'New bot',
    description: partial.description ?? '',
    systemPrompt: partial.systemPrompt ?? '',
    emoji: partial.emoji || '🤖',
    color: partial.color || '#7c9cff',
    ...avatarFields(partial),
    /*
     * `||`, not `??`: the bot editor starts its draft with `backendId: ''` and
     * posts every field explicitly, so an empty string — not `undefined` — is
     * what arrives when the user never opened the model menu. `??` let it
     * through, and the bot was saved pointing at no agent at all: its very first
     * turn failed with `Backend "" is not available`. The load-time
     * `resolveBackend` repaired it on the next launch, which made it look
     * intermittent. An empty choice is no choice, so it takes the default.
     */
    ...bindingFields(pinnedBinding(partial, settings)),
    tools: partial.tools ? stringList(partial.tools) : [...DEFAULT_BOT_TOOLS],
    skills: stringList(partial.skills),
    ...(stringList(partial.agentsMdIds).length ? { agentsMdIds: stringList(partial.agentsMdIds) } : {}),
    computerUse: partial.computerUse === true,
    // A target given here has just been probed by the caller — that is the
    // contract for setting one — so its capabilities are taken as verified.
    computerTarget: normaliseTarget(partial.computerTarget, id, { probed: true }),
    createdAt: now,
    updatedAt: now
  }
  if (partial.executionAgent?.accessMode === 'full-access' && !supportsFullAccessExecution(partial.executionAgent.backendId)) throw new TypeError('This CLI does not support the selected independent execution profile.')
  if (partial.executionAgent) bot.executionAgent = { ...partial.executionAgent }
  if (!bot.executionAgent && bot.tools.includes('delegate_task') && supportsExecutionDelegation(bot.backendId)) {
    bot.executionAgent = { backendId: bot.backendId, modelId: bot.modelId, ...(bot.thinking ? { thinking: bot.thinking } : {}) }
  }
  if (partial.archived === true) bot.archived = true
  if (partial.pinned === true) bot.pinned = true
  if (partial.computerTarget && bot.computerTarget.kind === 'vm') probedVms.add(id)
  return collection.put(bot)
}

export function duplicateBot(id: string): Bot | null {
  const source = collection.get(id)
  if (!source) return null
  const isolated = source.computerTarget.kind === 'vm'
  return createBot({
    ...source,
    name: `${source.name} copy`,
    ...(source.executionAgent ? { executionAgent: { ...source.executionAgent, accessMode: undefined } } : {}),
    archived: false,
    pinned: false,
    computerUse: isolated ? false : source.computerUse,
    computerTarget: isolated ? { kind: 'local' } : source.computerTarget
  })
}

export function updateBot(id: string, patch: Partial<Bot>): Bot | null {
  const existing = collection.get(id)
  if (!existing) return null
  const next: Bot = {
    ...existing,
    ...patch,
    // Identity and creation time are never patchable from the renderer.
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  }
  if (next.executionAgent?.accessMode === 'full-access' && !supportsFullAccessExecution(next.executionAgent.backendId)) throw new TypeError('This CLI does not support the selected independent execution profile.')
  if (existing.executionAgent?.accessMode === 'full-access' && JSON.stringify(next.executionAgent) !== JSON.stringify(existing.executionAgent)) revokeExecutorAccess(id)
  if (patch.tools) next.tools = stringList(patch.tools)
  if (JSON.stringify(next.tools) !== JSON.stringify(existing.tools)) {
    toolRevisions.set(id, botToolsRevision(id) + 1)
    if (existing.tools.some(tool => !next.tools.includes(tool))) revokeBotGrants(id)
  }
  if (next.computerUse !== existing.computerUse || JSON.stringify(next.computerTarget) !== JSON.stringify(existing.computerTarget)) revokeBotGrants(id)
  // `next` is a live object, not a document: its capabilities are either ones
  // this process probed or ones it has already refused to trust, so passing it
  // back through the disk rules would strip a bot's isolation on a rename.
  if (patch.computerTarget && next.computerTarget.kind === 'vm') probedVms.add(id)
  return withConfirmedTools(collection.put(normaliseBot(next, { probed: true }) ?? existing))
}

/** Whether a conversation remains a bot's home. */
export function conversationIsHome(sessionId: string): boolean {
  return Boolean(sessionId) && collection.all().some((bot) => bot.activeConversationId === sessionId)
}

/** Remove a home binding without deleting its conversation. */
export function releaseConversation(sessionId: string): void {
  for (const bot of collection.all()) {
    if (bot.activeConversationId === sessionId) updateBot(bot.id, { activeConversationId: '' })
  }
}

const failedRemovals = new Set<string>()

/** Re-establish a failed deletion's document before the task durability barrier.
 * A real write clears only this document's recorded error; unrelated failures
 * still prevent task removal. Never clear the global failure report blindly. */
export async function retryBotRemoval(id: string): Promise<void> {
  const bot = collection.get(id)
  if (!bot || !failedRemovals.has(id)) return
  await writeJsonNow(join(botsDir(), `${safeFileName(id)}.json`), bot)
  failedRemovals.delete(id)
}

/** Delete a bot and its memory. */
export function removeBot(id: string): boolean {
  const existed = collection.delete(id)
  if (existed) {
    failedRemovals.delete(id)
    clearBotMemory(id)
    clearVmToken(id)
    probedVms.delete(id)
    probedAt.delete(id)
  }
  return existed
}

/** Do not acknowledge deletion while the bot can still return after restart. */
export async function removeBotDurable(id: string): Promise<boolean> {
  if (!collection.has(id)) return false
  const file = join(botsDir(), `${safeFileName(id)}.json`)
  // An intentionally empty roster must survive startup's starter-Bot seeding.
  // Record this before removing the last document, including across a crash.
  if (collection.size === 1) await writeFile(join(botsDir(), '.keep-empty'), '1\n', { mode: 0o600 })
  await deleteJson(file)
  try {
    await access(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return removeBot(id)
    reviveJson(file)
    failedRemovals.add(id)
    throw new Error('The bot could not be deleted from local storage.')
  }
  // deleteJson retains failures for the shutdown report. Keep the live Bot
  // available so the user can retry without presenting an unpersisted success.
  reviveJson(file)
  failedRemovals.add(id)
  throw new Error('The bot could not be deleted from local storage.')
}

/** Create the starter bots when the bots directory is empty. */
export function seedBotsIfEmpty(): Bot[] {
  if (collection.size > 0 || collection.loadWasIncomplete || existsSync(join(botsDir(), '.keep-empty'))) return []
  return starterBots(getSettings()).map((seed, index) => {
    const now = Date.now() + index
    const { seedId, ...persona } = seed
    return collection.put({ ...persona, ...bindingFields(pinnedBinding(persona, getSettings())), id: seedId ?? randomUUID(), createdAt: now, updatedAt: now })
  })
}
