/**
 * Access to the backend registry, which is an optional peer module: when it is not part
 * of the build the loop reports "backend unavailable" instead of failing to load.
 */

import { UNCHECKED_BACKEND_DETAIL } from '../../shared/backendPrompt'
import type { BackendConfig, BackendInfo, ModelInfo, Settings, ToolCall } from '../../shared/types'
import type { Backend, ChatChunk, ChatRequest } from './contracts'
import { asRecord, asString, extractJson } from './json'
import { loadBackendRegistry, tryCall } from './optionalModules'
import { newId } from './ids'
import { settingsStore } from './settingsGateway'
import { localExecutionPolicy, LOCAL_EXECUTION_REFUSAL } from '../../shared/localExecution'
import { usesApplicationToolLoop } from '../../shared/executionAgentCapabilities'
import { requestApproval } from './approval'
import { evaluate } from './approvalPolicy'
import { localOperationSignal } from '../localExecution'
import { matchesAnyDeny } from './patterns'
import { onSettingsChanged } from '../settings'

export async function getBackend(id: string): Promise<Backend | null> {
  if (!id) return null
  const registry = await loadBackendRegistry()
  const backend = await tryCall(
    registry?.getBackend ? () => registry.getBackend!(id) : undefined,
    null as Backend | null | undefined
  )
  return backend && typeof backend.chat === 'function' ? backend : null
}

let inflight: Promise<BackendInfo[]> | null = null

function usable(infos: BackendInfo[] | null | undefined): BackendInfo[] {
  return Array.isArray(infos) ? infos.filter((info) => !!info?.id) : []
}

/** Probe every backend. Single-flight, and never started by a chat send. */
async function probeAll(): Promise<BackendInfo[]> {
  if (inflight) return inflight
  inflight = (async () => {
    const registry = await loadBackendRegistry()
    const { backends } = await settingsStore.get()
    const infos = await tryCall(
      registry?.detectAll ? () => registry.detectAll!(backends) : undefined,
      [] as BackendInfo[]
    )
    return usable(infos)
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/**
 * Last probe, or a placeholder row per backend.
 * Reads the in-memory status cache after the first disk load, so a boot scan
 * that finishes between two messages is visible to the next one. No CLI is spawned.
 */
async function rememberedBackends(): Promise<BackendInfo[]> {
  const registry = await loadBackendRegistry()
  const infos = await tryCall(
    registry?.cachedBackendInfos ? () => registry.cachedBackendInfos!() : undefined,
    [] as BackendInfo[]
  )
  return usable(infos)
}

/**
 * Backend rows for a chat turn.
 *
 * A fresh probe spawns every CLI (`--version`, then `login status`). Settings
 * refresh and the boot scan do that on their own. Send must not: it held the
 * reply bubble back for the whole scan, and a second copy of the same CLI
 * competed with the one about to chat. `force` is the explicit scan.
 */
export async function detectBackends(force = false): Promise<BackendInfo[]> {
  if (force) return probeAll()
  return rememberedBackends()
}

export async function getBackendInfo(id: string): Promise<BackendInfo | null> {
  const found = (await detectBackends()).find((info) => info.id === id)
  if (found) return found
  // No row yet (registry still loading). Kind lives on the adapter itself, so
  // the turn can still choose supervised vs orchestrated without a probe.
  const backend = await getBackend(id)
  if (!backend) return null
  return {
    id: backend.id,
    label: backend.label,
    kind: backend.kind,
    status: 'error',
    statusDetail: UNCHECKED_BACKEND_DETAIL,
    models: [],
    local: backend.local,
    toolMode: backend.kind === 'local-server' ? 'prompted' : 'native',
    ...(backend.supportsVmOrchestration ? { supportsVmOrchestration: true } : {})
  }
}

export async function getModelInfo(backendId: string, modelId: string): Promise<ModelInfo | null> {
  const info = await getBackendInfo(backendId)
  if (!info || !Array.isArray(info.models)) return null
  return info.models.find((model) => model?.id === modelId) ?? null
}

export function backendConfigFor(settings: Settings, backendId: string): BackendConfig {
  return settings.backends?.[backendId] ?? { enabled: true }
}

/** Coerce whatever the model produced into a well-formed `ToolCall`. */
export function normaliseCall(raw: Record<string, unknown>): ToolCall {
  const rawArgs = raw['args'] ?? raw['arguments'] ?? raw['parameters'] ?? raw['input']
  const args = typeof rawArgs === 'string' ? asRecord(extractJson(rawArgs)) : asRecord(rawArgs)
  return {
    id: asString(raw['id']) || newId('call'),
    name: asString(raw['name'] ?? raw['tool'] ?? raw['function']),
    args
  }
}

/**
 * Open a chat stream. Tolerates a backend that hands back a promise for the iterable, and
 * turns anything non-iterable into a clean error the loop can report.
 */
export async function openChatStream(
  backend: Backend,
  req: ChatRequest,
  cfg: BackendConfig
): Promise<AsyncIterable<ChatChunk>> {
  if (req.readOnly && req.disableNativeTools && backend.modelOnlyChat) {
    // Capability belongs to the adapter, not to a caller flag or backend name.
    // A pure inference request never receives application/MCP tools.
    if (req.tools?.length || req.mcpServers?.length) throw new Error('Model-only inference cannot carry tools')
    const settings = await settingsStore.get()
    if (matchesAnyDeny(settings.denylist ?? [], [`tool:${backend.id}`])) throw new Error('The user explicitly blocked this backend')
    return (async function* () {
      const controller = new AbortController()
      const unsubscribe = onSettingsChanged(next => {
        if (matchesAnyDeny(next.denylist ?? [], [`tool:${backend.id}`])) controller.abort(new Error('The user blocked this backend'))
      })
      try {
        const latest = await settingsStore.get()
        if (matchesAnyDeny(latest.denylist ?? [], [`tool:${backend.id}`])) throw new Error('The user blocked this backend')
        yield* backend.modelOnlyChat!({ ...req, signal: AbortSignal.any([req.signal, controller.signal]) }, cfg)
      } finally { unsubscribe() }
    })()
  }
  if (backend.kind === 'agent-cli' && !usesApplicationToolLoop(backend.id)) {
    const settings = await settingsStore.get()
    if (localExecutionPolicy(settings) === 'never-allow') throw new Error(LOCAL_EXECUTION_REFUSAL)
    const task = req.messages.filter((m) => m.role === 'user').at(-1)?.content
    const target = typeof task === 'string' ? task.slice(0, 2000) : '(task with attachments)'
    // Optional memory/routing side calls have no owning chat approval surface.
    // Fail closed instead of creating an orphan card or running silently.
    if (req.readOnly && !req.localExecutionSessionId &&
        evaluate(settings, backend.id, target, new Set(), false, false, true).outcome !== 'allow') {
      throw new Error('后台原生 CLI 调用需要人工确认，已跳过。 / This native CLI side call requires a user decision and was skipped.')
    }
    const outcome = await requestApproval({
      sessionId: req.localExecutionSessionId ?? req.sessionKey ?? backend.id,
      toolName: backend.id, localExecution: true, target, kind: 'shell', signal: req.signal,
      summary: `${backend.label} · ${settings.language === 'en' ? 'Run on this Mac' : '在这台电脑上执行'}`,
      detail: `Agent: ${backend.label}\nWorking folder: ${req.cwd ?? ''}\n\n${target}\n\n` +
        '批准范围是本轮原生 CLI 任务：它可以使用自己的文件、搜索和运行工具，内部调用无法逐项拦截；显式权限请求仍单独确认。拒绝后不会启动本轮任务。\n' +
        'Approval covers this native CLI task, including its own file, search and execution tools. Internal calls cannot all be intercepted. Explicit permission requests still receive separate review. Rejecting does not start this task.'
    })
    if (!outcome.approved) throw new Error(`本轮原生 CLI 任务未获批准。 / Native CLI task was not approved: ${outcome.reason}`)
    const operation = localOperationSignal(req.signal, settings)
    return (async function* () {
      try {
        for await (const chunk of backend.chat({ ...req, signal: operation.signal }, cfg)) {
          operation.signal.throwIfAborted()
          yield chunk
        }
        // Some native transports close quietly on revocation. Partial prose
        // is not a completed turn when the narrower operation was cancelled.
        operation.signal.throwIfAborted()
      } catch (error) {
        if (operation.signal.aborted) throw new DOMException('Native CLI turn cancelled after local execution permission changed or the request stopped.', 'AbortError')
        throw error
      }
      finally { operation.dispose() }
    })()
  }
  const out: unknown = await Promise.resolve(backend.chat(req, cfg))
  if (!out || typeof out !== 'object' || !(Symbol.asyncIterator in (out as object))) {
    throw new Error('backend returned no stream')
  }
  return out as AsyncIterable<ChatChunk>
}

/** Drain a stream into text and tool calls. Used by one-shot side calls. */
export async function collectTurn(
  stream: AsyncIterable<ChatChunk>
): Promise<{ text: string; reasoning: string; calls: ToolCall[] }> {
  let text = ''
  let reasoning = ''
  const calls: ToolCall[] = []
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text') text += chunk.delta ?? ''
    else if (chunk.type === 'reasoning') reasoning += chunk.delta ?? ''
    else if (chunk.type === 'tool_call' && chunk.call) {
      calls.push(normaliseCall(asRecord(chunk.call)))
    } else if (chunk.type === 'done') break
  }
  return { text, reasoning, calls }
}

/**
 * A short side call — memory extraction, adaptive replay. Returns null rather than
 * throwing, so those features simply skip when inference is unavailable.
 */
export async function runSideCall(
  backendId: string,
  req: ChatRequest,
  settings: Settings,
  onUnavailable?: (error: unknown) => void
): Promise<{ text: string; reasoning: string; calls: ToolCall[] } | null> {
  try {
    const backend = await getBackend(backendId)
    if (!backend) return null
    const stream = await openChatStream(backend, req, backendConfigFor(settings, backendId))
    return await collectTurn(stream)
  } catch (error) {
    onUnavailable?.(error)
    return null
  }
}
