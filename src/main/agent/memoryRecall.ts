/** Rank durable memories for the current user message without a model call. */
import type { MemoryEntry } from '../../shared/types'
import { screenMemoryPrivacy } from './memoryFilter'

export type MemoryKind = 'profile' | 'journal' | 'note'
export type MemoryRecallKind = 'profile' | 'journal' | 'all'

/** Existing untyped entries retain their identity; these are views, not a migration. */
export function memoryKind(entry: MemoryEntry): MemoryKind {
  if (entry.tags?.includes('journal')) return 'journal'
  return entry.tags?.some(tag => tag === 'profile' || tag === 'user-preference') ? 'profile' : 'note'
}

export function memorySourceBotId(entry: MemoryEntry): string | undefined {
  return entry.tags?.map(tag => /^source:bot:([A-Za-z0-9._-]{1,120})$/.exec(tag)?.[1]).find(Boolean)
}

function safeMemory(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.flatMap(entry => {
    const checked = screenMemoryPrivacy(entry.text)
    if (!checked.ok || !checked.text || entry.tags?.some(tag => !screenMemoryPrivacy(tag).ok)) return []
    return [{ ...entry, text: checked.text }]
  })
}

const COMMON_WORDS = new Set(['this', 'that', 'with', 'from', 'what', 'when', 'then', 'have', 'please', '需要', '可以', '一下', '这个', '那个', '现在', '我们', '用户', '已经', '没有', '问题', '进行'])

/** Unicode-aware matching: Latin terms and adjacent Han bigrams. */
function terms(text: string): Set<string> {
  const found = new Set<string>()
  const normal = text.toLocaleLowerCase().slice(0, 2000)
  for (const word of normal.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      const chars = Array.from(word)
      for (let i = 0; i < chars.length - 1; i++) {
        const pair = chars[i] + chars[i + 1]
        if (!COMMON_WORDS.has(pair)) found.add(pair)
      }
    } else if (word.length >= 2 && !COMMON_WORDS.has(word)) found.add(word)
  }
  return found
}

/**
 * Prefer relevant user-stated rules, then other relevant memories, then the
 * most recent user-stated rules and remaining recent memories. Date is kept
 * on every result, so a newer correction can override an older related rule.
 * Return a new array; the stored records and their ordering remain unchanged.
 */
export function rankMemory(entries: readonly MemoryEntry[], query: string): MemoryEntry[] {
  const queryTerms = terms(query)
  return entries.map((entry, index) => {
    let matches = 0
    for (const term of terms(entry.text)) if (queryTerms.has(term)) matches++
    const preference = entry.source === 'user' && entry.tags?.includes('user-preference') === true
    return { entry, index, matches, preference }
  }).sort((a, b) => {
    const aGroup = a.matches ? (a.preference ? 0 : 1) : (a.preference ? 2 : 3)
    const bGroup = b.matches ? (b.preference ? 0 : 1) : (b.preference ? 2 : 3)
    const byTime = (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0)
    // Newer corrections should win even if an older preference happens to
    // share more literal words with the current request.
    return aGroup - bGroup || (a.preference && b.preference ? byTime || b.matches - a.matches : b.matches - a.matches || byTime) || a.index - b.index
  }).map(({ entry }) => entry)
}

/** On-demand retrieval is scoped by the host before entering this pure helper. */
export function recallMemories(entries: readonly MemoryEntry[], query: string, options: { kind?: MemoryRecallKind; limit?: number } = {}): MemoryEntry[] {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase().slice(0, 2000)
  if (!needle) return []
  const queryTerms = terms(needle)
  const candidates = safeMemory(entries).filter(entry => {
    if (options.kind && options.kind !== 'all' && memoryKind(entry) !== options.kind) return false
    const text = entry.text.normalize('NFKC').toLocaleLowerCase()
    return text.includes(needle) || [...terms(text)].some(term => queryTerms.has(term))
  })
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit!))) : 20
  return rankMemory(candidates, needle).slice(0, limit)
}

/** Small stable profile allocation, then recent journal plus ranked recall.
 * The caller reserves its heading/metadata budget before asking for entries. */
export function memoryContextEntries(entries: readonly MemoryEntry[], tokenBudget: number): MemoryEntry[] {
  const safe = safeMemory(entries), selected: MemoryEntry[] = []
  let remaining = Math.max(0, Math.floor(tokenBudget))
  const cost = (entry: MemoryEntry): number => Math.ceil(Math.min(entry.text.length, 400) / 4) + 40
  const append = (items: MemoryEntry[], allocation: number): void => {
    let available = Math.min(remaining, allocation)
    for (const entry of items) {
      if (selected.some(value => value.id === entry.id)) continue
      const tokens = cost(entry)
      if (tokens > available) continue
      selected.push(entry); available -= tokens; remaining -= tokens
    }
  }
  const recent = (items: MemoryEntry[]): MemoryEntry[] => [...items].sort((a, b) => b.createdAt - a.createdAt)
  // Profiles are independent of query relevance; journal/note volume cannot evict them.
  append(recent(safe.filter(entry => memoryKind(entry) === 'profile')), Math.min(400, Math.max(100, Math.floor(remaining * .4))))
  append(recent(safe.filter(entry => memoryKind(entry) === 'journal')).slice(0, 5), Math.max(120, Math.floor(remaining * .4)))
  append(safe.filter(entry => memoryKind(entry) !== 'profile'), remaining)
  return selected
}

/** Exact declared subjects only. This is a conservative review cue, never an
 * automatic semantic conflict resolver or authority to replace a memory. */
export function memoryConflictPeers(entry: MemoryEntry, entries: readonly MemoryEntry[]): MemoryEntry[] {
  if (entry.botId !== '__blinky_user_preferences__' || memoryKind(entry) !== 'profile') return []
  const subject = (item: MemoryEntry): string => item.tags?.find(tag => tag.startsWith('field:'))?.toLocaleLowerCase()
    ?? item.text.match(/^([^:：\n]{2,32})[:：]/)?.[1]?.trim().toLocaleLowerCase() ?? ''
  const key = subject(entry)
  if (!key) return []
  return entries.filter(other => other.id !== entry.id && other.botId === entry.botId && memoryKind(other) === 'profile' && subject(other) === key && other.text.trim() !== entry.text.trim()).sort((a, b) => b.createdAt - a.createdAt)
}
