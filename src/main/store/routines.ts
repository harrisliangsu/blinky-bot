/**
 * Routines — recorded step sequences a bot can replay.
 * One `routines/<id>.json` per routine.
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Routine, RoutineStep, RoutineStepKind } from '../../shared/types'
import { JsonCollection } from './collection'
import { routinesDir, safeFileName } from './paths'
import { writeJsonNow } from './jsonStore'
import { isValidCron, isValidScheduleOptions } from '../routines/cron'
import { validGitHubIssueTarget } from '../connectors/githubTarget'

const STEP_KINDS: ReadonlyArray<RoutineStepKind> = [
  'observe',
  'click',
  'double_click',
  'type',
  'key',
  'scroll',
  'drag',
  'open_app',
  'navigate',
  'wait',
  'tool',
  'assert'
]

function normaliseSteps(value: unknown): RoutineStep[] {
  if (!Array.isArray(value)) return []
  const out: RoutineStep[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const source = raw as Record<string, unknown>
    const kind = source['kind']
    if (!(STEP_KINDS as ReadonlyArray<string>).includes(kind as string)) continue
    const step: RoutineStep = {
      id: typeof source['id'] === 'string' && source['id'] ? source['id'] : randomUUID(),
      kind: kind as RoutineStepKind,
      intent: typeof source['intent'] === 'string' ? source['intent'] : ''
    }
    const params = source['params']
    if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
      step.params = params as Record<string, unknown>
    }
    if (typeof source['reference'] === 'string') step.reference = source['reference']
    out.push(step)
  }
  return out
}

function normaliseRoutine(raw: unknown): Routine | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = typeof value['id'] === 'string' ? value['id'] : ''
  if (!id) return null
  const trigger = value['trigger']
  const triggerFields = typeof trigger === 'object' && trigger !== null ? trigger as Record<string, unknown> : {}
  const requestedTriggerKind = triggerFields.kind
  const cron =
    typeof trigger === 'object' && trigger !== null
      ? (trigger as Record<string, unknown>)['cron']
      : undefined

  const routine: Routine = {
    id,
    botId: typeof value['botId'] === 'string' ? value['botId'] : '',
    name: typeof value['name'] === 'string' && value['name'] ? value['name'] : 'Untitled routine',
    description: typeof value['description'] === 'string' ? value['description'] : '',
    steps: normaliseSteps(value['steps']),
    trigger: { kind: requestedTriggerKind === 'schedule' && typeof cron === 'string' && isValidCron(cron) && isValidScheduleOptions(triggerFields) ? 'schedule' :
      requestedTriggerKind === 'once' && Number.isSafeInteger(triggerFields.at) && Number(triggerFields.at) >= 0 && isValidScheduleOptions(triggerFields) ? 'once' :
      requestedTriggerKind === 'folder_change' && typeof triggerFields.path === 'string' && isAbsolute(triggerFields.path) ? 'folder_change' :
      requestedTriggerKind === 'github_issue' && typeof triggerFields.owner === 'string' && typeof triggerFields.repo === 'string' && typeof triggerFields.issueNumber === 'number' && validGitHubIssueTarget(triggerFields.owner, triggerFields.repo, triggerFields.issueNumber) ? 'github_issue' :
      requestedTriggerKind === 'gmail_query' && typeof triggerFields.query === 'string' && triggerFields.query.length <= 512 && typeof triggerFields.account === 'string' && triggerFields.account.length > 0 && triggerFields.account.length <= 320 ? 'gmail_query' :
      requestedTriggerKind === 'webhook' ? 'webhook' : 'manual' },
    replayMode: value['replayMode'] === 'literal' ? 'literal' : 'adaptive',
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now()
  }
  routine.notifyPolicy = value['notifyPolicy'] === 'quiet' || value['notifyPolicy'] === 'on_change' ? value['notifyPolicy'] : 'always'
  if (routine.trigger.kind === 'schedule' && typeof cron === 'string') routine.trigger.cron = cron.trim()
  if (routine.trigger.kind === 'schedule' || routine.trigger.kind === 'once') {
    if (typeof triggerFields.tz === 'string' && routine.trigger.kind === 'schedule') routine.trigger.tz = triggerFields.tz
    if (typeof triggerFields.earlyMinutes === 'number' && routine.trigger.kind === 'schedule') routine.trigger.earlyMinutes = triggerFields.earlyMinutes
    if (typeof triggerFields.lateMinutes === 'number') routine.trigger.lateMinutes = triggerFields.lateMinutes
  }
  if (routine.trigger.kind === 'once') routine.trigger.at = triggerFields.at as number
  if (routine.trigger.kind === 'folder_change') routine.trigger.path = triggerFields.path as string
  if (routine.trigger.kind === 'github_issue') {
    routine.trigger.owner = triggerFields.owner as string; routine.trigger.repo = triggerFields.repo as string; routine.trigger.issueNumber = triggerFields.issueNumber as number
  }
  if (routine.trigger.kind === 'gmail_query') {
    routine.trigger.query = triggerFields.query as string; routine.trigger.account = triggerFields.account as string
    if (typeof triggerFields.accountId === 'string') routine.trigger.accountId = triggerFields.accountId
  }
  if (routine.trigger.kind === 'github_issue' || routine.trigger.kind === 'gmail_query' || routine.trigger.kind === 'folder_change') {
    if (typeof value['watchCursor'] === 'string' && /^[a-f0-9]{64}$/.test(value['watchCursor'])) routine.watchCursor = value['watchCursor']
    if (typeof value['watchCheckedAt'] === 'number' && Number.isFinite(value['watchCheckedAt'])) routine.watchCheckedAt = value['watchCheckedAt']
    if (typeof value['watchError'] === 'string') routine.watchError = value['watchError'].slice(0, 500)
  }
  if (typeof value['lastRunAt'] === 'number') routine.lastRunAt = value['lastRunAt']
  if (typeof value['lastRunId'] === 'string' && /^[a-f0-9]{64}$/.test(value['lastRunId'])) routine.lastRunId = value['lastRunId']
  if (typeof value['instruction'] === 'string' && value['instruction'].trim()) routine.instruction = value['instruction'].slice(0, 20_000)
  if (['claimed', 'running', 'awaiting_review', 'finished', 'failed', 'unknown', 'missed', 'skipped'].includes(value['lastRunState'] as string)) routine.lastRunState = value['lastRunState'] as Routine['lastRunState']
  if (typeof value['lastRunError'] === 'string') routine.lastRunError = value['lastRunError'].slice(0, 2000)
  return routine
}

const collection = new JsonCollection<Routine>(routinesDir, normaliseRoutine)
export const routinesLoadWasIncomplete = (): boolean => collection.loadWasIncomplete

export async function loadRoutines(): Promise<void> {
  await collection.load()
  for (const routine of collection.all()) {
    if (routine.lastRunState === 'running') collection.put({ ...routine, lastRunState: 'unknown', lastRunError: 'BlinkyBot closed during this run. Inspect its work before retrying.' })
  }
}

/** All routines, newest first; optionally filtered to one bot. */
export function listRoutines(botId?: string): Routine[] {
  const all = collection.all()
  const filtered = botId ? all.filter((routine) => routine.botId === botId) : all
  return filtered.sort((a, b) => b.createdAt - a.createdAt)
}

export function getRoutine(id: string): Routine | null {
  return collection.get(id)
}

/** Upsert a routine — used by the recorder when it finishes capturing. */
export function saveRoutine(routine: Routine): Routine {
  return collection.put(normaliseRoutine(routine) ?? routine)
}

function newRoutine(partial: Partial<Routine>): Routine {
  const routine: Routine = {
    id: randomUUID(),
    botId: partial.botId ?? '',
    name: partial.name?.trim() || 'New routine',
    description: partial.description ?? '',
    steps: normaliseSteps(partial.steps),
    ...(partial.instruction?.trim() ? { instruction: partial.instruction.trim().slice(0, 20_000) } : {}),
    trigger: partial.trigger ?? { kind: 'manual' },
    replayMode: partial.replayMode === 'literal' ? 'literal' : 'adaptive',
    notifyPolicy: partial.notifyPolicy ?? 'always',
    ...(partial.watchCursor ? { watchCursor: partial.watchCursor, watchCheckedAt: partial.watchCheckedAt } : {}),
    createdAt: Date.now()
  }
  const normalised = normaliseRoutine(routine)
  if (!normalised) throw new Error('The routine could not be normalized before creation.')
  return normalised
}

export function createRoutine(partial: Partial<Routine> = {}): Routine {
  return collection.put(newRoutine(partial))
}

/** Do not expose a scheduled instruction until its own file is durable. */
export async function createRoutineDurable(partial: Partial<Routine> = {}): Promise<Routine> {
  const routine = newRoutine(partial)
  await writeJsonNow(join(routinesDir(), `${safeFileName(routine.id)}.json`), routine)
  return collection.put(routine)
}

function applyRoutinePatch(existing: Routine, patch: Partial<Routine>): Routine {
  const next = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt }
  if (patch.trigger && JSON.stringify(existing.trigger) !== JSON.stringify(patch.trigger)) {
    delete next.watchCursor; delete next.watchCheckedAt; delete next.watchError
    if (patch.trigger.kind === 'once') { delete next.lastRunAt; delete next.lastRunId; delete next.lastRunState; delete next.lastRunError }
  }
  if (existing.trigger.kind !== 'schedule' && patch.trigger?.kind === 'schedule') {
    // Scheduling starts now. Do not interpret the routine's original recording
    // date as downtime and immediately run a newly enabled old routine.
    next.lastRunAt = Date.now()
  }
  return normaliseRoutine(next) ?? existing
}

export function updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
  const existing = collection.get(id)
  return existing ? collection.put(applyRoutinePatch(existing, patch)) : null
}

/** Write the edited routine before acknowledging it, rebasing concurrent state changes. */
export async function updateRoutineDurable(id: string, patch: Partial<Routine>): Promise<Routine | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = collection.get(id)
    if (!existing) return null
    const next = applyRoutinePatch(existing, patch)
    await writeJsonNow(join(routinesDir(), `${safeFileName(id)}.json`), next)
    if (collection.get(id) === existing) return collection.put(next)
  }
  throw new Error('The routine is changing too quickly to save the edit safely.')
}

/** Stamp a successful (or attempted) replay. */
export function markRoutineRun(id: string, at = Date.now()): Routine | null {
  const existing = collection.get(id)
  if (!existing) return null
  return collection.put({ ...existing, lastRunAt: at })
}

export function setRoutineRunState(id: string, state: NonNullable<Routine['lastRunState']>, error?: string): Routine | null {
  const existing = collection.get(id)
  if (!existing) return null
  const next: Routine = { ...existing, lastRunState: state }
  if (error) next.lastRunError = error.slice(0, 2000)
  else delete next.lastRunError
  return collection.put(next)
}

export function removeRoutine(id: string): boolean {
  return collection.delete(id)
}

/** Delete every manual or scheduled routine owned by a deleted bot. */
export function removeRoutinesForBot(botId: string): number {
  let removed = 0
  for (const routine of collection.all()) {
    if (routine.botId === botId && collection.delete(routine.id)) removed += 1
  }
  return removed
}

/** Conventional name the agent loop's recorder resolves `saveRoutine` by. */
export const save = saveRoutine

/** Conventional short name for `updateRoutine`. */
export const update = updateRoutine
