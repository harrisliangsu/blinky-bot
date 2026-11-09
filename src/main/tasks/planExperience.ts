/**
 * Decomposition experience for task planning.
 *
 * Completed tasks contribute their validated plan context (scope and
 * boundaries); new goals retrieve the most similar past decompositions so
 * the Bot starts from proven structure instead of an empty page. Local
 * text similarity only — no embeddings, no external service.
 */

import { join } from 'node:path'
import type { AgentTask } from '../../shared/types'
import { dataRoot } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { scrubVaultTranscript } from '../store/vaultPrivacy'

export interface PlanExperienceEntry {
  id: string
  title: string
  categories: string[]
  scope: string[]
  boundaries: string[]
  at: number
}

interface ExperienceFile { version: 1; entries: PlanExperienceEntry[] }

const file = (): string => join(dataRoot(), 'plan-experience.json')
const MAX_ENTRIES = 200
const REFERENCE_CHAR_BUDGET = 1000

async function load(): Promise<PlanExperienceEntry[]> {
  const read = await readJsonState<ExperienceFile | null>(file(), null)
  if (read.status !== 'ok' || !read.value || read.value.version !== 1 || !Array.isArray(read.value.entries)) return []
  return (read.value.entries as unknown[]).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item['id'] !== 'string' || typeof item['title'] !== 'string' || !Array.isArray(item['scope'])) return []
    return [{
      id: item['id'],
      title: scrubVaultTranscript(item['title']).slice(0, 120),
      categories: (Array.isArray(item['categories']) ? item['categories'] : []).flatMap((c) => typeof c === 'string' ? [scrubVaultTranscript(c).slice(0, 40)] : []).slice(0, 6),
      scope: item['scope'].flatMap((s) => typeof s === 'string' ? [scrubVaultTranscript(s).slice(0, 120)] : []).slice(0, 8),
      boundaries: (Array.isArray(item['boundaries']) ? item['boundaries'] : []).flatMap((b) => typeof b === 'string' ? [scrubVaultTranscript(b).slice(0, 160)] : []).slice(0, 6),
      at: Number(item['at']) || Date.now()
    }]
  })
}

/** A completed task contributes its plan context; blocked outcomes never teach. */
export async function capturePlanExperience(task: AgentTask): Promise<void> {
  const context = task.plan?.context
  if (!context || task.status !== 'completed' || task.review?.outcome === 'blocked') return
  const entries = await load()
  const title = scrubVaultTranscript(task.title)
  if (entries.some((entry) => entry.title === title)) return
  entries.push({ id: task.id, title, categories: context.categories.map((c) => scrubVaultTranscript(c)).slice(0, 6), scope: context.scope.map((s) => scrubVaultTranscript(s)).slice(0, 8), boundaries: context.boundaries.map((b) => scrubVaultTranscript(b)).slice(0, 6), at: Date.now() })
  while (entries.length > MAX_ENTRIES) entries.shift()
  await writeJsonNow(file(), { version: 1, entries })
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  const clean = text.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ')
  for (const word of clean.split(' ')) {
    if (!word) continue
    if (/^[a-z0-9]+$/.test(word)) { out.add(word); continue }
    for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2))
  }
  return out
}

/** Most similar past decompositions for a new goal, bounded for the tool envelope. */
export async function planExperienceReferences(goalText: string, categories?: string[], limit = 3): Promise<Array<Pick<PlanExperienceEntry, 'title' | 'scope' | 'boundaries'>>> {
  const entries = await load()
  if (!entries.length) return []
  const goal = bigrams(goalText)
  const cats = new Set((categories ?? []).map((c) => c.toLowerCase()))
  const scored = entries.map((entry) => {
    let score = 0
    const entryTokens = bigrams(entry.title + ' ' + entry.scope.join(' ') + ' ' + entry.categories.join(' '))
    for (const token of goal) if (entryTokens.has(token)) score += 1
    for (const category of entry.categories) if (cats.has(category.toLowerCase())) score += 4
    return { entry, score }
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
  const out: Array<Pick<PlanExperienceEntry, 'title' | 'scope' | 'boundaries'>> = []
  let size = 0
  for (const { entry } of scored) {
    const value = { title: entry.title, scope: entry.scope, boundaries: entry.boundaries }
    const length = JSON.stringify(value).length
    if (out.length && size + length > REFERENCE_CHAR_BUDGET) break
    out.push(value)
    size += length
    if (out.length >= limit) break
  }
  return out
}
