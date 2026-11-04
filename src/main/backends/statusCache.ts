/**
 * Last-known backend status, persisted to the cache directory.
 *
 * Lets the UI render the backend list instantly at launch — before any probe
 * has finished — and then swap in fresh results when detection completes.
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { CliAuthInfo, CliAuthState } from '../../shared/cliAuth'
import { publicAccountLabel } from './cli/authStatus'
import type { BackendInfo, BackendStatus, ModelInfo } from '../../shared/types'
import { cacheFilePath } from './userDataPaths'

const CACHE_FILE = 'backend-status.json'

export interface StoredStatus {
  status: BackendStatus
  statusDetail?: string
  models: ModelInfo[]
  toolMode: 'native' | 'prompted'
  supportsVmOrchestration?: boolean
  cliAuth?: CliAuthInfo
  at: number
}

const AUTH_STATES = new Set<CliAuthState>(['not-installed', 'logged-out', 'logged-in', 'unknown'])

function storedAuth(value: unknown): CliAuthInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = (value as { state?: unknown }).state
  if (typeof state !== 'string' || !AUTH_STATES.has(state as CliAuthState)) return undefined
  const account = publicAccountLabel(
    typeof (value as { account?: unknown }).account === 'string'
      ? (value as { account: string }).account
      : undefined
  )
  return { state: state as CliAuthState, ...(account ? { account } : {}) }
}

let memory: Record<string, StoredStatus> | undefined

export async function readStatusCache(): Promise<Record<string, StoredStatus>> {
  if (memory) return memory
  try {
    const file = await cacheFilePath(CACHE_FILE)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, StoredStatus>
    memory = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    memory = {}
  }
  return memory
}

export async function rememberStatuses(infos: BackendInfo[]): Promise<void> {
  const next: Record<string, StoredStatus> = { ...(await readStatusCache()) }
  for (const info of infos) {
    next[info.id] = {
      status: info.status,
      ...(info.statusDetail ? { statusDetail: info.statusDetail } : {}),
      models: info.models,
      toolMode: info.toolMode,
      ...(info.supportsVmOrchestration ? { supportsVmOrchestration: true } : {}),
      ...(info.cliAuth ? { cliAuth: storedAuth(info.cliAuth) } : {}),
      at: Date.now()
    }
  }
  memory = next
  try {
    await writeFile(await cacheFilePath(CACHE_FILE), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // The cache is an optimisation; losing it only costs a slower first paint.
  }
}

export function clearStatusCacheMemo(): void {
  memory = undefined
}
