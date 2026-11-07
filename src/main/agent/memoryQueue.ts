/** Durable references to unfinished memory extraction, never conversation text. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { dataRoot, ensureDir, safeFileName } from '../store/paths'
import { readJsonDirState, readJsonState, writeJsonNow } from '../store/jsonStore'
import type { TurnMode } from './backendMode'

export interface MemoryJob {
  id: string
  sessionId: string
  botId: string
  boundaryId: string
  mode: TurnMode
  memoryFingerprint: string
  state: 'pending' | 'writing'
  createdAt: number
}

/** Decisions never infer that an interrupted write has succeeded or is safe to repeat. */
export function decideMemoryJob(job: MemoryJob, state: { sourceExists: boolean; boundaryExists: boolean; enabled: boolean; fingerprint: string }): 'run' | 'discard' | 'uncertain' {
  if (!state.sourceExists || !state.boundaryExists || !state.enabled) return 'discard'
  if (job.state === 'writing' || state.fingerprint !== job.memoryFingerprint) return 'uncertain'
  return 'run'
}

function directory(): string { return ensureDir(join(dataRoot(), 'memory-extraction')) }
function file(id: string): string { return join(directory(), `${safeFileName(id)}.json`) }

function isJob(value: unknown): value is MemoryJob {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<MemoryJob>
  return typeof job.id === 'string' && !!job.id && typeof job.sessionId === 'string' && !!job.sessionId &&
    typeof job.botId === 'string' && !!job.botId && typeof job.boundaryId === 'string' && !!job.boundaryId &&
    (job.mode === 'supervised' || job.mode === 'orchestrated') &&
    typeof job.memoryFingerprint === 'string' && /^[a-f0-9]{64}$/.test(job.memoryFingerprint) &&
    (job.state === 'pending' || job.state === 'writing') && typeof job.createdAt === 'number'
}

export async function createMemoryJob(input: Omit<MemoryJob, 'id' | 'state' | 'createdAt'>): Promise<MemoryJob> {
  const job: MemoryJob = { ...input, id: randomUUID(), state: 'pending', createdAt: Date.now() }
  await writeJsonNow(file(job.id), job)
  return job
}

export async function saveMemoryJob(job: MemoryJob): Promise<void> {
  await writeJsonNow(file(job.id), job)
}

export async function readMemoryJob(id: string): Promise<MemoryJob | null> {
  const result = await readJsonState<unknown>(file(id), null)
  return isJob(result.value) && result.value.id === id ? result.value : null
}

export async function removeMemoryJob(job: MemoryJob): Promise<void> {
  await fs.rm(file(job.id), { force: true })
}

/** Malformed or unreadable records are never treated as completed work. */
export async function loadMemoryJobs(): Promise<{ jobs: MemoryJob[]; incomplete: boolean }> {
  const result = await readJsonDirState<unknown>(directory())
  const jobs: MemoryJob[] = []
  let invalid = false
  for (const document of result.documents) {
    if (isJob(document.value) && document.file === file(document.value.id)) jobs.push(document.value)
    else invalid = true
  }
  return { jobs: jobs.sort((a, b) => a.createdAt - b.createdAt), incomplete: result.incomplete || invalid }
}
