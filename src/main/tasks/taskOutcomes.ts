/**
 * Execution outcome records: the data asset behind plan-vs-actual learning.
 *
 * Every terminal task contributes one bounded record (planned scope and
 * boundaries, actual outcome, duration, error class). Nothing here feeds a
 * model yet — the records exist so future decomposition aids learn from what
 * actually happened instead of from what was hoped.
 */

import { join } from 'node:path'
import type { AgentTask } from '../../shared/types'
import { dataRoot } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { scrubVaultTranscript } from '../store/vaultPrivacy'

export interface TaskOutcomeRecord {
  taskId: string
  title: string
  categories: string[]
  plannedScope: string[]
  plannedBoundaries: string[]
  outcome: 'completed' | 'failed' | 'cancelled' | 'blocked'
  durationMs: number
  error?: string
  at: number
}

interface OutcomesFile { version: 1; entries: TaskOutcomeRecord[] }

const file = (): string => join(dataRoot(), 'task-outcomes.json')
const MAX_RECORDS = 500

let queue: Promise<unknown> = Promise.resolve()
let seen = new Set<string>()

/** Serialize appends: terminal transitions can arrive back to back, and a
 *  read-modify-write race would drop every record but the last. An in-memory
 *  seen set short-circuits bursts so they do not re-read the file per task. */
export function recordTaskOutcome(task: AgentTask): Promise<unknown> {
  if (seen.size > 5000) seen = new Set()
  queue = queue.then(() => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    return writeOutcome(task)
  }).catch(() => {})
  return queue
}

/** Teardown hook: wait until every scheduled outcome write has landed. */
export function flushOutcomes(): Promise<unknown> { return queue }

async function writeOutcome(task: AgentTask): Promise<void> {
  const read = await readJsonState<OutcomesFile | null>(file(), null)
  const entries: TaskOutcomeRecord[] = read.status === 'ok' && read.value && read.value.version === 1 && Array.isArray(read.value.entries) ? read.value.entries : []
  if (entries.some((entry) => entry.taskId === task.id)) return
  const outcome: TaskOutcomeRecord['outcome'] = task.status === 'completed' ? (task.review?.outcome === 'blocked' ? 'blocked' : 'completed') : task.status === 'failed' ? 'failed' : 'cancelled'
  entries.push({
    taskId: task.id,
    title: scrubVaultTranscript(task.title).slice(0, 120),
    categories: (task.plan?.context?.categories ?? []).map((c) => scrubVaultTranscript(c)).slice(0, 6),
    plannedScope: (task.plan?.context?.scope ?? []).map((s) => scrubVaultTranscript(s)).slice(0, 8),
    plannedBoundaries: (task.plan?.context?.boundaries ?? []).map((b) => scrubVaultTranscript(b)).slice(0, 6),
    outcome,
    durationMs: Math.max(0, Date.now() - task.createdAt),
    ...(task.error ? { error: scrubVaultTranscript(task.error).slice(0, 300) } : {}),
    at: Date.now()
  })
  while (entries.length > MAX_RECORDS) entries.shift()
  await writeJsonNow(file(), { version: 1, entries })
}
