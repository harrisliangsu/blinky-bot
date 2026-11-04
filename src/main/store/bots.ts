/**
 * Bots — personas with their own prompt, tools and memory.
 * One `bots/<id>.json` per bot; starter personas live in `starterBots.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { Bot, ComputerTarget } from '../../shared/types'
import { getSettings } from '../settings'
import { KNOWN_BACKEND_IDS } from '../settingsSchema'
import { JsonCollection } from './collection'
import { botsDir } from './paths'
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
  if (!stored || !KNOWN_BACKEND_IDS.includes(stored)) {
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

/** Set during load when any bot referenced a backend this build dropped. */
let retiredBackendSeen = false
/** Set during load when a legacy bot carried a plaintext VM bearer token. */
let plaintextVmTokenSeen = false
/** Set during load when the seeded general-purpose bot was still named Assistant. */
let seededAssistantSeen = false

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
    return { kind: 'browser', botId }
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
    ...resolveBackend(value['backendId'], value['modelId']),
    tools: stringList(value['tools']),
    skills: stringList(value['skills']),
    computerUse: value['computerUse'] === true,
    computerTarget: normaliseTarget(value['computerTarget'], id, opts),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : now,
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : now
  }
  if (value['archived'] === true) bot.archived = true
  if (value['pinned'] === true) bot.pinned = true
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
  await collection.load()
  // Persist the normalised values so the migration happens exactly once.
  if (retiredBackendSeen || plaintextVmTokenSeen || seededAssistantSeen) {
    for (const bot of collection.all()) collection.put(bot)
  }
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
  return bots.sort((a, b) => {
    const archived = Number(a.archived ?? false) - Number(b.archived ?? false)
    if (archived !== 0) return archived
    const pinned = Number(b.pinned ?? false) - Number(a.pinned ?? false)
    return pinned !== 0 ? pinned : a.createdAt - b.createdAt
  })
}

export function getBot(id: string): Bot | null {
  return collection.get(id)
}

/** The bot a new session defaults to. */
export function defaultBotId(): string {
  return listBots().find((bot) => !bot.archived)?.id ?? ''
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
    /*
     * `||`, not `??`: the bot editor starts its draft with `backendId: ''` and
     * posts every field explicitly, so an empty string — not `undefined` — is
     * what arrives when the user never opened the model menu. `??` let it
     * through, and the bot was saved pointing at no agent at all: its very first
     * turn failed with `Backend "" is not available`. The load-time
     * `resolveBackend` repaired it on the next launch, which made it look
     * intermittent. An empty choice is no choice, so it takes the default.
     */
    backendId: partial.backendId || settings.defaultBackendId,
    modelId: partial.modelId || settings.defaultModelId,
    tools: partial.tools ? stringList(partial.tools) : [...DEFAULT_BOT_TOOLS],
    skills: stringList(partial.skills),
    computerUse: partial.computerUse === true,
    // A target given here has just been probed by the caller — that is the
    // contract for setting one — so its capabilities are taken as verified.
    computerTarget: normaliseTarget(partial.computerTarget, id, { probed: true }),
    createdAt: now,
    updatedAt: now
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
  if (patch.tools) next.tools = stringList(patch.tools)
  // `next` is a live object, not a document: its capabilities are either ones
  // this process probed or ones it has already refused to trust, so passing it
  // back through the disk rules would strip a bot's isolation on a rename.
  if (patch.computerTarget && next.computerTarget.kind === 'vm') probedVms.add(id)
  return collection.put(normaliseBot(next, { probed: true }) ?? existing)
}

/** Delete a bot and its memory. */
export function removeBot(id: string): boolean {
  const existed = collection.delete(id)
  if (existed) {
    clearBotMemory(id)
    clearVmToken(id)
    probedVms.delete(id)
    probedAt.delete(id)
  }
  return existed
}

/** Create the starter bots when the bots directory is empty. */
export function seedBotsIfEmpty(): Bot[] {
  if (collection.size > 0) return []
  return starterBots(getSettings()).map((seed, index) => {
    const now = Date.now() + index
    const { seedId, ...persona } = seed
    return collection.put({ ...persona, id: seedId ?? randomUUID(), createdAt: now, updatedAt: now })
  })
}
