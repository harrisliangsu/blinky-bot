/**
 * The two peer modules that may not be part of a given build.
 *
 * `import.meta.glob` is resolved by the bundler: it compiles to an empty map when
 * the file is absent and to a real lazy chunk when it exists. A plain
 * `import('…')` would fail the packaged build instead, since the specifier is
 * resolved at build time and there is no runtime left to catch in.
 *
 * Everything else the loop depends on — the stores, the IPC broadcaster, the
 * backend and tool type contracts — is imported statically, so a rename there is
 * a compile error rather than a silent no-op.
 */

import type {
  BackendConfig,
  BackendInfo,
  ComputerTarget,
  ToolCall,
  ToolResult,
  ToolSchema
} from '../../shared/types'
import type { Backend, Tool, ToolContext } from './contracts'
import { errorMessage } from './errors'

export interface BackendRegistry {
  getBackend(id: string): Backend | null | undefined | Promise<Backend | null | undefined>
  detectAll(
    configs?: Record<string, BackendConfig>
  ): BackendInfo[] | Promise<BackendInfo[]>
  /** Last probe, or a placeholder row per backend. Never spawns a CLI. */
  cachedBackendInfos?: () => BackendInfo[] | Promise<BackendInfo[]>
}

export interface ToolRegistry {
  getTool(name: string): Tool | null | undefined
  schemasFor(enabledIds: string[], target?: ComputerTarget): ToolSchema[]
  runTool(call: ToolCall, context: ToolContext): ToolResult | Promise<ToolResult>
}

const backendCandidates = import.meta.glob('../backends/registry.ts')
const toolCandidates = import.meta.glob('../tools/registry.ts')

function loader(
  candidates: Record<string, () => Promise<unknown>>
): (() => Promise<unknown>) | undefined {
  return Object.values(candidates)[0]
}

function makeLoader<T>(
  label: string,
  candidates: Record<string, () => Promise<unknown>>
): () => Promise<Partial<T> | null> {
  let cached: Promise<Partial<T> | null> | null = null
  let warned = false

  return () => {
    if (cached) return cached
    const load = loader(candidates)
    if (!load) {
      if (!warned) {
        warned = true
        console.warn(`[agent] ${label} is not part of this build`)
      }
      return Promise.resolve(null)
    }
    cached = load()
      .then((mod) => (mod ?? null) as Partial<T> | null)
      .catch((err) => {
        // Do not memoise a failure: a later call gets a fresh attempt.
        cached = null
        console.warn(`[agent] ${label} unavailable: ${errorMessage(err)}`)
        return null
      })
    return cached
  }
}

export const loadBackendRegistry = makeLoader<BackendRegistry>(
  'backend registry',
  backendCandidates
)

export const loadToolRegistry = makeLoader<ToolRegistry>('tool registry', toolCandidates)

/** Call an optional registry function, treating any failure as "not available". */
export async function tryCall<T>(fn: (() => T | Promise<T>) | undefined, fallback: T): Promise<T> {
  if (typeof fn !== 'function') return fallback
  try {
    const out = await fn()
    return out === undefined || out === null ? fallback : out
  } catch (err) {
    console.warn(`[agent] registry call failed: ${errorMessage(err)}`)
    return fallback
  }
}
