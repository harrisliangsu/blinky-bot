/**
 * Per-bot long-term memory.
 *
 * One document per bot — `memory/<botId>.json` — holding that bot's entries in
 * insertion order. Documents are self-describing (`{ botId, entries }`) so a
 * renamed file can never orphan its contents.
 */

import { createHash, randomUUID } from 'node:crypto'
import { screenMemoryPrivacy } from '../agent/memoryFilter'
import { join } from 'node:path'
import type { MemoryEntry } from '../../shared/types'
import { deleteJson, readJsonDirState, reviveJson, writeJsonDebounced, writeJsonNow } from './jsonStore'
import { memoryDir, safeFileName } from './paths'
import { requireVaultSafeMemory, scrubVaultTextsNow } from './vault'

interface MemoryDoc {
  botId: string
  entries: MemoryEntry[]
  protection?: MemoryProtection
}

interface MemoryProtection {
  version: 1
  revision: number
  automaticAfter: number
  blocked: string[]
  restored: string[]
  receipts: Record<string, string>
  blockedAt?: Record<string, number>
  restoredAt?: Record<string, number>
}
const protections = new Map<string, MemoryProtection>()
const mutations = new Map<string, Promise<unknown>>()
const digest = (text: string): string => createHash('sha256').update(text.normalize('NFKC').replace(/^(?:请)?(?:(?:重新|再次)记住|记住|牢记|(?:please\s+)?remember(?:\s+again)?)\s*[:：，,]?\s*/i,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).digest('hex')
const receiptKey = (id: string): string => createHash('sha256').update(id).digest('hex')
function protection(botId: string): MemoryProtection {
  return protections.get(botId) ?? { version: 1, revision: 0, automaticAfter: 0, blocked: [], restored: [], receipts: {} }
}
function document(botId: string): MemoryDoc { return { botId, entries: cache.get(botId) ?? [], protection: protection(botId) } }
function mutate<T>(botId: string, work: () => Promise<T>): Promise<T> {
  const previous = mutations.get(botId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  mutations.set(botId, next)
  void next.finally(() => { if (mutations.get(botId) === next) mutations.delete(botId) }).catch(() => undefined)
  return next
}
function changed(botId: string, update: (value: MemoryProtection) => void): void {
  const value = structuredClone(protection(botId))
  value.revision++
  update(value)
  protections.set(botId, value)
}
export function automaticMemoryCutoff(botId: string): number { return Math.max(protection(botId).automaticAfter, protection(USER_PREFERENCES_ID).automaticAfter) }
export function memoryProtectionRevision(botId: string): number[] { return [protection(botId).revision, protection(USER_PREFERENCES_ID).revision] }
export function automaticMemoryBlocked(botId: string, text: string): boolean {
  const key = digest(text), own = protection(botId), shared = protection(USER_PREFERENCES_ID)
  const blocked = Math.max(own.blocked.includes(key) ? ((own.blockedAt?.[key] ?? own.automaticAfter) || 1) : 0, shared.blocked.includes(key) ? ((shared.blockedAt?.[key] ?? shared.automaticAfter) || 1) : 0)
  return blocked > Math.max(own.restoredAt?.[key] ?? 0, shared.restoredAt?.[key] ?? 0)
}
function nextOrder(): number {
  let order = Date.now()
  for (const value of protections.values()) for (const at of [...Object.values(value.blockedAt ?? {}), ...Object.values(value.restoredAt ?? {})]) order = Math.max(order, at)
  return order + 1
}
function forget(botId: string, entry: MemoryEntry): void {
  changed(botId, value => {
    const key = digest(entry.text)
    value.blocked = [...new Set([...value.blocked, key])]
    value.blockedAt = { ...value.blockedAt, [key]: nextOrder() }
    value.restored = value.restored.filter(hash => hash !== key)
    value.automaticAfter = Date.now()
    for (const tag of entry.tags ?? []) if (tag.startsWith('message:')) value.receipts[receiptKey(tag)] = entry.id
  })
}

const SOURCES: ReadonlyArray<MemoryEntry['source']> = ['run', 'user', 'exchange']

/** Limit new input length; context budgets do not authorize evicting stored facts. */
const MAX_TEXT = 2000
/** A separate document keeps user-wide preferences when an individual bot is deleted. */
const USER_PREFERENCES_ID = '__blinky_user_preferences__'

const cache = new Map<string, MemoryEntry[]>()
let loaded = false
let loading: Promise<void> | undefined

function fileFor(botId: string): string {
  return join(memoryDir(), `${safeFileName(botId)}.json`)
}

function persist(botId: string): void {
  const doc = document(botId)
  writeJsonDebounced(fileFor(botId), doc)
}

function normaliseEntry(raw: unknown, botId: string): MemoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const text = typeof value['text'] === 'string' ? value['text'] : ''
  if (text.trim() === '') return null
  const source = value['source']
  const tags = Array.isArray(value['tags'])
    ? value['tags'].filter((t): t is string => typeof t === 'string')
    : undefined
  const entry: MemoryEntry = {
    id: typeof value['id'] === 'string' && value['id'] ? value['id'] : randomUUID(),
    botId: typeof value['botId'] === 'string' && value['botId'] ? value['botId'] : botId,
    text,
    source: (SOURCES as ReadonlyArray<string>).includes(source as string)
      ? (source as MemoryEntry['source'])
      : 'user',
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now()
  }
  if (tags && tags.length) entry.tags = tags
  return entry
}

/**
 * The bots whose memory document existed but could not be read.
 *
 * The cache is not the whole truth for those bots, and rewriting the document —
 * which every add does, wholesale — would delete the facts that did not load.
 * One `remember` call after a failed read destroyed the rest.
 *
 * Held per bot, by file, because the alternative was worse than the bug: a
 * single locked document turned persistence off for *every* bot for the rest of
 * the session, so memories the user watched being saved were gone at the next
 * launch, with only a console line to say why. A bot whose own document read
 * cleanly has nothing to lose by being written.
 */
const unreadable = new Set<string>()
let memoryDirectoryUnreadable = false

/** False for a bot whose document did not load: its cache is not complete. */
function persistable(botId: string): boolean {
  return loaded && !memoryDirectoryUnreadable && !unreadable.has(fileFor(botId))
}

/** Read every memory document into the cache. */
export async function loadMemory(): Promise<void> {
  if (!loading) loading = readMemory().then(() => { loaded = true }).catch(error => { loading = undefined; throw error })
  return loading
}

async function readMemory(): Promise<void> {
  const read = await readJsonDirState<unknown>(memoryDir())
  memoryDirectoryUnreadable = read.incomplete && read.unreadable.length === 0 && read.corrupt.length === 0
  for (const file of [...read.unreadable, ...read.corrupt]) unreadable.add(file)
  for (const raw of read.values) {
    if (typeof raw !== 'object' || raw === null) continue
    const doc = raw as Record<string, unknown>
    const botId = typeof doc['botId'] === 'string' ? doc['botId'] : ''
    // Tolerate the legacy/bare shape of a naked array as well.
    const rawEntries = Array.isArray(doc['entries'])
      ? doc['entries']
      : Array.isArray(raw)
        ? (raw as unknown[])
        : []
    const entries: MemoryEntry[] = []
    for (const rawEntry of rawEntries) {
      const entry = normaliseEntry(rawEntry, botId)
      if (entry) entries.push(entry)
    }
    const key = botId || entries[0]?.botId
    if (!key) continue
    const metadata = doc['protection'] as MemoryProtection | undefined
    if (doc['protection'] !== undefined) {
      const hashes = (items: unknown): items is string[] => Array.isArray(items) && items.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
      const orders = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key,at]) => /^[a-f0-9]{64}$/.test(key) && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0))
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.version !== 1 || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 || !Number.isFinite(metadata.automaticAfter) || !hashes(metadata.blocked) || !hashes(metadata.restored) || !metadata.receipts || typeof metadata.receipts !== 'object' || Array.isArray(metadata.receipts) || Object.entries(metadata.receipts).some(([id,value]) => !/^[a-f0-9]{64}$/.test(id) || typeof value !== 'string') || !orders(metadata.blockedAt) || !orders(metadata.restoredAt)) unreadable.add(fileFor(key))
      else protections.set(key, metadata)
    }
    // Context budgets are separate; migration must not evict existing facts.
    cache.set(key, entries)
  }
}

/** Every entry for a bot, oldest first. */
export function listBotMemory(botId: string): MemoryEntry[] {
  const own = cache.get(botId) ?? []
  const entries = botId === USER_PREFERENCES_ID ? [...own] : [...own, ...(cache.get(USER_PREFERENCES_ID) ?? [])].filter(entry => entry.source === 'user' || !automaticMemoryBlocked(botId, entry.text))
  const text = entries.map(entry => [entry.text, ...(entry.tags ?? [])].join('\n'))
  const checked = scrubVaultTextsNow(text)
  return checked.unavailable ? [] : entries.filter((_entry, i) => checked.texts[i] === text[i])
}

/** Persist a directly stated preference before acknowledging its capture. */
export async function addUserPreference(text: string, messageId?: string): Promise<MemoryEntry | null> {
  return mutate(USER_PREFERENCES_ID, async () => {
  if (!persistable(USER_PREFERENCES_ID)) {
    throw new Error('user preference document could not be read; refusing to overwrite it')
  }
  const receipt = messageId ? receiptKey(`message:${messageId}`) : undefined
  if (receipt && protection(USER_PREFERENCES_ID).receipts[receipt]) {
    const existing = (cache.get(USER_PREFERENCES_ID) ?? []).find(e => e.id === protection(USER_PREFERENCES_ID).receipts[receipt])
    if (existing) requireVaultSafeMemory(existing.text, ...(existing.tags ?? []))
    return existing ?? null
  }
  const previousPolicy = protection(USER_PREFERENCES_ID)
  const previousTime = cache.get(USER_PREFERENCES_ID)?.at(-1)?.createdAt ?? 0
  const tags = ['user-preference', ...(messageId ? [`message:${messageId}`] : [])]
  const entry = addBotMemory(USER_PREFERENCES_ID, text, 'user', tags)
  changed(USER_PREFERENCES_ID, value => {
    value.blocked = value.blocked.filter(key => key !== digest(text))
    value.restoredAt = { ...value.restoredAt, [digest(text)]: nextOrder() }
    if (receipt) value.receipts[receipt] = entry.id
  })
  entry.createdAt = Math.max(entry.createdAt, previousTime + 1)
  try {
    await writeJsonNow(fileFor(USER_PREFERENCES_ID), document(USER_PREFERENCES_ID))
  } catch (error) {
    // Do not mistake an in-memory-only entry for a durable duplicate on retry.
    cache.set(USER_PREFERENCES_ID, (cache.get(USER_PREFERENCES_ID) ?? []).filter((item) => item.id !== entry.id))
    protections.set(USER_PREFERENCES_ID, previousPolicy)
    throw error
  }
  return entry
  })
}

export function listUserPreferences(): MemoryEntry[] {
  return listBotMemory(USER_PREFERENCES_ID)
}

export function addBotMemory(
  botId: string,
  text: string,
  source: MemoryEntry['source'] = 'user',
  tags?: string[]
): MemoryEntry {
  if (!persistable(botId)) throw new Error('memory document could not be read; refusing to overwrite it')
  if (source !== 'user' && automaticMemoryBlocked(botId, text)) throw new Error('该事实已被用户忘记，未自动恢复。')
  const screened = screenMemoryPrivacy(text)
  if (!screened.ok || !screened.text) throw new Error('记忆包含敏感信息，未保存。')
  requireVaultSafeMemory(text, screened.text, ...(tags ?? []))
  const entry: MemoryEntry = {
    id: randomUUID(),
    botId,
    text: screened.text.slice(0, MAX_TEXT),
    source,
    createdAt: Date.now()
  }
  if (tags && tags.length) entry.tags = tags.filter((t) => typeof t === 'string')
  const existing = cache.get(botId)
  // No cached document means this one is being created, which after
  // `clearBotMemory` means recreated — the only caller allowed to write over a
  // path the store has tombstoned as deleted.
  if (!existing) reviveJson(fileFor(botId))
  const entries = [...(existing ?? []), entry]
  cache.set(botId, entries)
  // Held in memory for this session, but never written back over a document we
  // could not read in full.
  persist(botId)
  return entry
}

/** A tool must not report a memory as saved until the write succeeds. */
export async function addBotMemoryDurable(botId: string, text: string, source: MemoryEntry['source'] = 'user', tags?: string[]): Promise<MemoryEntry> {
  return mutate(botId, async () => {
  if (automaticMemoryBlocked(botId, text)) throw new Error('该事实已被用户忘记，未自动恢复。')
  const entry = addBotMemory(botId, text, source, tags)
  try {
    await writeJsonNow(fileFor(botId), document(botId))
    return entry
  } catch (error) {
    cache.set(botId, (cache.get(botId) ?? []).filter((item) => item.id !== entry.id))
    throw error
  }
  })
}

export function removeBotMemory(botId: string, entryId: string): boolean {
  // The same shared preference is visible from every bot's memory controls.
  if (botId !== USER_PREFERENCES_ID &&
      (cache.get(USER_PREFERENCES_ID) ?? []).some((entry) => entry.id === entryId)) {
    return removeBotMemory(USER_PREFERENCES_ID, entryId)
  }
  const entries = cache.get(botId)
  if (!entries) return false
  const requested = entries.find(entry => entry.id === entryId)
  const next = entries.filter((entry) => entry.id !== entryId && (!requested || digest(entry.text) !== digest(requested.text)))
  if (next.length === entries.length) return false
  const removed = entries.find(entry => entry.id === entryId)!
  forget(botId, removed)
  cache.set(botId, next)
  // Same rule as adding, which this used to ignore: rewriting a document that
  // did not load drops every entry the read never saw, and a removal rewrites
  // it just as wholesale as an add does.
  if (persistable(botId)) persist(botId)
  return true
}

function ownerFor(botId: string, entryId?: string): string {
  return entryId && (cache.get(USER_PREFERENCES_ID) ?? []).some(entry => entry.id === entryId) ? USER_PREFERENCES_ID : botId
}

/** UI-only explicit intent: edit and restore are atomic with their suppression metadata. */
export async function writeUserMemory(botId: string, text: string, replaceEntryId?: string, requestId?: string, shared = false, kind?: 'profile' | 'journal' | 'note'): Promise<MemoryEntry | null> {
  const owner = shared && !replaceEntryId ? USER_PREFERENCES_ID : ownerFor(botId, replaceEntryId)
  return mutate(owner, async () => {
    if (!persistable(owner)) throw new Error('记忆文件不可读取，未覆盖已有记忆。')
    const key = requestId ? receiptKey(`request:${requestId}`) : undefined
    if (key && protection(owner).receipts[key]) {
      const existing = (cache.get(owner) ?? []).find(entry => entry.id === protection(owner).receipts[key])
      if (existing) requireVaultSafeMemory(existing.text, ...(existing.tags ?? []))
      return existing ?? null
    }
    const before = cache.get(owner), policy = protection(owner)
    const prior = replaceEntryId ? (before ?? []).find(entry => entry.id === replaceEntryId) : undefined
    if (replaceEntryId && !prior) throw new Error('原记忆已改变或删除，请刷新后重试。')
    const screened = screenMemoryPrivacy(text)
    if (!screened.ok || !screened.text) throw new Error('记忆包含敏感信息，未保存。')
    requireVaultSafeMemory(text, screened.text, ...(prior?.tags ?? []))
    if (prior) removeBotMemory(owner, prior.id)
    let tags = prior?.tags ? [...prior.tags] : owner === USER_PREFERENCES_ID ? ['user-preference', `source:bot:${botId}`] : []
    if (kind !== undefined) {
      tags = tags.filter(tag => tag !== 'profile' && tag !== 'journal')
      if (kind !== 'note') tags.push(kind)
    }
    const entry = addBotMemory(owner, screened.text, 'user', tags.length ? tags : undefined)
    changed(owner, value => {
      value.blocked = value.blocked.filter(hash => hash !== digest(entry.text))
      value.restored = [...new Set([...value.restored, digest(entry.text)])]
      value.restoredAt = { ...value.restoredAt, [digest(entry.text)]: nextOrder() }
      if (key) value.receipts[key] = entry.id
    })
    try { await writeJsonNow(fileFor(owner), document(owner)); return entry }
    catch (error) { cache.set(owner, before ?? []); protections.set(owner, policy); persist(owner); throw error }
  })
}

export async function removeBotMemoryDurable(botId: string, entryId: string): Promise<boolean> {
  const owner = ownerFor(botId, entryId)
  return mutate(owner, async () => {
    if (!persistable(owner)) throw new Error('记忆文件不可读取，未执行删除。')
    const before = cache.get(owner), policy = protection(owner)
    const removed = removeBotMemory(owner, entryId)
    try { await writeJsonNow(fileFor(owner), document(owner)); return removed }
    catch (error) { cache.set(owner, before ?? []); protections.set(owner, policy); persist(owner); throw error }
  })
}

/** Drop a bot's whole memory document — used when the bot is deleted. */
export function clearBotMemory(botId: string): void {
  cache.delete(botId)
  void deleteJson(fileFor(botId))
}

/* ── conventional aliases ────────────────────────────────────────── */

/**
 * The agent loop resolves store functions by conventional name (`list`,
 * `add`) rather than by import, so it stays decoupled from this module's
 * internals. These are the names it looks for.
 */
export const list = listBotMemory

export function add(botId: string, text: string, entry?: Partial<MemoryEntry>): MemoryEntry {
  return addBotMemory(botId, text, entry?.source ?? 'run', entry?.tags)
}
