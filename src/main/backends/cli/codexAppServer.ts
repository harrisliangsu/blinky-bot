/**
 * Codex over `app-server` — a persistent, session-based transport.
 *
 * Unlike one-shot `codex exec`, the app server keeps a thread alive and asks
 * the CLIENT before running commands or editing files. Those requests are
 * routed to OpenBOT's approval gate, which is the entire reason for preferring
 * this path.
 *
 * The process used to be spawned, handshaken and killed on every message.
 * `initialize` plus `thread/start` is a cold CLI start — the pause before the
 * first token. A successful turn now leaves the process and its thread warm
 * for a couple of minutes, and the next message in that conversation sends
 * only the new user text on the thread Codex already has.
 */

import { AsyncQueue } from '../asyncQueue'
import { JsonRpcPeer } from '../jsonRpc'
import { diagnosticTail } from '../vaultRedaction'
import { type ProcessHandle, spawnLines } from '../spawnProcess'
import { noteTiming, type TimingObserver } from '../chatTiming'
import type { ChatChunk, ChatRequest, ProviderMessage } from '../types'
import { isPlainObject } from '../lenientJson'
import { imagePartsOf, textOf } from '../messageContent'
import {
  approvalResponse,
  CodexItems,
  codexNotification,
  describeApproval,
  isTurnEnd
} from './codexEvents'
import { type CodexPoolIdentity, codexPoolKey } from './codexPool'
import { codexSafety } from './codexSafety'
import { allowCoordinatorGatewayCall, answerCodexUserInput } from './codexElicitation'
import type { CliRunContext } from './spec'
import { codexTurnItems, materializeCodexImages, turnImages, MAX_TURN_IMAGES } from './cliImages'
import { codexTurnPrompt } from './codexThread'
import { codexThreadCall, forgetCodexThread, rememberCodexThread, rememberedCodexThread, threadIdOf } from './codexThread'
import { fingerprints, rememberSent } from './resumePrompt'
import { flushProviderBindings, sessionKeyMatches } from '../../store/providerBindings'

/**
 * Ceiling on the handshake. An app-server that starts and then never answers
 * `initialize` would leave the request pending forever.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000

/** Keep recent sessions ready across short pauses, with a bound on idle processes. */
const WARM_IDLE_MS = 300_000
const MAX_IDLE_SERVERS = 3

const MAX_DIAGNOSTIC_LINES = 200

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`codex app-server did not answer ${what} within ${ms / 1000}s`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval'
]

interface ThreadStarted {
  threadId?: string
  thread?: { id?: string }
  approvalsReviewer?: string
  approvalPolicy?: unknown
  sandbox?: unknown
}

export interface AppServerRun {
  binaryPath: string
  ctx: CliRunContext
  req: ChatRequest
  /** `-c` overrides and the token variables they name, from `mcpConfig`. */
  mcp?: { args: string[]; env: Record<string, string> }
}

interface WarmCodex {
  key: string
  sessionKey?: string
  handle: ProcessHandle
  peer: JsonRpcPeer
  threadId: string
  /** True after one turn completed on this thread. */
  primed: boolean
  sink: AsyncQueue<ChatChunk> | null
  items: CodexItems
  diagnostics: string[]
  failure: unknown
  turnEnded: boolean
  /** Bumps on every turn so a late RPC rejection cannot fail the next one. */
  generation: number
  activeTurnId?: string
  /** Bound to the model used by this turn, even if settings change mid-run. */
  supportsVision: boolean
  captureAgentTrace: boolean
  onTiming?: TimingObserver
  steered: ProviderMessage[]
  pendingSteers: Set<Promise<unknown>>
  turnImageCleanups: Array<() => Promise<void>>
  approve?: ChatRequest['approve']
  requestInput?: ChatRequest['requestInput']
  idle?: ReturnType<typeof setTimeout>
  idleSince?: number
  unbind?: () => void
  disposed: boolean
}

const warm = new Map<string, WarmCodex>()

let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const live of warm.values()) {
      try {
        live.handle.kill()
      } catch {
        // Exiting anyway.
      }
    }
    warm.clear()
  })
}

function noteDiag(live: WarmCodex, line: string): void {
  live.diagnostics.push(line)
  if (live.diagnostics.length > MAX_DIAGNOSTIC_LINES) live.diagnostics.shift()
}

function dispose(live: WarmCodex): void {
  if (live.disposed) return
  live.disposed = true
  if (live.idle) clearTimeout(live.idle)
  live.idle = undefined
  live.idleSince = undefined
  live.unbind?.()
  live.unbind = undefined
  if (warm.get(live.key) === live) warm.delete(live.key)
  live.sink?.close()
  live.peer.close(new Error('codex app-server closed'))
  live.handle.kill()
}

function armIdle(live: WarmCodex): void {
  if (live.idle) clearTimeout(live.idle)
  live.idleSince = Date.now()
  live.idle = setTimeout(() => dispose(live), WARM_IDLE_MS)
  live.idle.unref?.()
}

/** Never evict an active turn; oldest idle servers are discarded first. */
function trimIdleServers(): void {
  const idle = [...warm.values()].filter((live) => live.idle && live.sink === null && !live.disposed).sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))
  while (idle.length > MAX_IDLE_SERVERS) dispose(idle.shift()!)
}

/** Discard cached processes for a reset conversation before its next turn. */
export function stopWarmCodexForSession(sessionId: string): void {
  for (const live of [...warm.values()]) {
    if (live.sessionKey && sessionKeyMatches(live.sessionKey, sessionId)) dispose(live)
  }
}

/** Kill every warm Codex process. Called on app quit beside the other pools. */
export function stopWarmCodex(): void {
  for (const live of [...warm.values()]) dispose(live)
  warm.clear()
}

function wire(live: WarmCodex, handle: ProcessHandle, run: AppServerRun): void {
  live.peer = new JsonRpcPeer(
    (line) => handle.write(`${line}\n`),
    (method, params) => {
      try {
        // An app-server connection may report events for more than one thread.
        // Never let an explicitly foreign thread advance or finish this turn.
        if (isPlainObject(params) && typeof params.threadId === 'string' && live.threadId && params.threadId !== live.threadId) return
        const eventTurn = isPlainObject(params) && typeof params.turnId === 'string' ? params.turnId
          : isPlainObject(params) && isPlainObject(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : undefined
        if (eventTurn && live.activeTurnId && eventTurn !== live.activeTurnId) return
        if (method === 'turn/started' && isPlainObject(params) && isPlainObject(params.turn) && typeof params.turn.id === 'string') {
          live.activeTurnId = params.turn.id
          noteTiming(live.onTiming, 'model-request-accepted')
        }
        const chunks = codexNotification(method, params, live.items, live.captureAgentTrace)
        for (const chunk of chunks) live.sink?.push(chunk)
        if (isTurnEnd(method)) {
          live.turnEnded = true
          live.activeTurnId = undefined
          live.sink?.close()
        }
      } catch (err) {
        live.failure = err
        live.sink?.close()
      }
    }
  )

  for (const method of APPROVAL_METHODS) {
    live.peer.onRequest(method, async (params) => {
      if (isPlainObject(params) && typeof params.threadId === 'string' && live.threadId && params.threadId !== live.threadId) {
        return approvalResponse(method, params, 'reject')
      }
      if (isPlainObject(params) && typeof params.turnId === 'string' && live.activeTurnId && params.turnId !== live.activeTurnId) {
        return approvalResponse(method, params, 'reject')
      }
      const request = describeApproval(method, params, live.items)
      const approve = live.approve
      if (!request || !approve) return approvalResponse(method, params, 'reject')
      const decision = await approve(request)
      return approvalResponse(method, params, decision)
    })
  }

  // Codex asks for MCP approval before contacting our gateway. For the
  // coordinator's own gateway, let the call reach that gateway, where the
  // bot's tool grant, coordinator restrictions and approval policy are enforced.
  // Do not accept arbitrary MCP elicitations or other servers' tool calls.
  live.peer.onRequest('mcpServer/elicitation/request', (params) => {
    const allowed = allowCoordinatorGatewayCall(params, {
      coordinator: run.req.coordinatorOnly === true,
      hasGateway: run.req.mcpServers?.some((server) => server.name === 'openbot') === true,
      active: !!live.sink,
      threadId: live.threadId,
      turnId: live.activeTurnId
    })
    return { action: allowed ? 'accept' : 'decline' }
  })

  live.peer.onRequest('item/tool/requestUserInput', (params) => {
    const generation = live.generation, turnId = live.activeTurnId
    return answerCodexUserInput(params, { threadId: live.threadId, turnId, active: () => Boolean(live.sink && !live.disposed && !live.turnEnded && live.generation === generation && live.activeTurnId === turnId) }, live.requestInput)
  })

  const pump = (async () => {
    for await (const { stream, line } of handle.lines) {
      if (stream === 'stdout') live.peer.handleLine(line)
      else if (line.trim()) noteDiag(live, line)
    }
  })()
    .catch((err: unknown) => {
      live.failure ??= err
    })
    .finally(() => {
      if (live.disposed) return
      if (live.sink && !live.turnEnded && live.failure == null && !run.req.signal.aborted) {
        live.failure = new Error(
          appServerFailure(new Error('codex app-server stopped before the turn finished'), live.diagnostics)
        )
      }
      dispose(live)
    })
  // The rejection is observed; the process exit is what ends the turn.
  void pump
}

async function handshake(live: WarmCodex, run: AppServerRun): Promise<void> {
  await withDeadline(
    live.peer.request('initialize', {
      clientInfo: { name: 'BlinkyBot', title: 'BlinkyBot', version: '0.1.0' }
    }),
    HANDSHAKE_TIMEOUT_MS,
    'initialize'
  )
  live.peer.notify('initialized')
  noteTiming(run.req.onTiming, 'runtime-ready')

  const oldThread = reusable(run) ? rememberedCodexThread(run.req.sessionKey) : undefined
  const safety = codexSafety(run.req)
  let call = codexThreadCall({ threadId: oldThread, cwd: run.ctx.cwd, model: run.ctx.model, ...safety })
  let started: ThreadStarted
  try {
    started = await withDeadline(live.peer.request<ThreadStarted>(call.method, call.params), HANDSHAKE_TIMEOUT_MS, call.method)
    live.primed = Boolean(oldThread)
  } catch (error) {
    if (!oldThread || run.req.signal.aborted) throw error
    forgetCodexThread(run.req.sessionKey)
    call = codexThreadCall({ cwd: run.ctx.cwd, model: run.ctx.model, ...safety })
    started = await withDeadline(live.peer.request<ThreadStarted>(call.method, call.params), HANDSHAKE_TIMEOUT_MS, call.method)
    live.primed = false
  }
  const threadId = threadIdOf(started)
  if (!threadId) throw new Error('codex app-server did not return a thread id')
  if (safety.approvalsReviewer === 'auto_review' && (started.approvalsReviewer !== 'auto_review' || started.approvalPolicy !== 'on-request' || !isPlainObject(started.sandbox) || started.sandbox.type !== 'workspaceWrite' || started.sandbox.networkAccess !== false)) throw new Error('Codex did not confirm sandboxed automatic approval review. Update Codex or choose an interactive approval policy; this run was not started.')
  if (run.req.coordinatorOnly && (started.approvalsReviewer !== 'user' || started.approvalPolicy !== 'on-request' || !isPlainObject(started.sandbox) || started.sandbox.type !== 'readOnly' || started.sandbox.networkAccess !== false)) throw new Error('Codex did not confirm the read-only coordinator boundary; the turn was not started.')
  live.threadId = threadId
  noteTiming(run.req.onTiming, 'thread-ready')
  if (reusable(run)) {
    rememberCodexThread(run.req.sessionKey, threadId)
    await flushProviderBindings()
  }
}

async function boot(run: AppServerRun, key: string): Promise<WarmCodex> {
  installExitHook()
  const handle = await spawnLines(run.binaryPath, {
    onTiming: run.req.onTiming,
    args: ['app-server', ...(run.req.coordinatorOnly ? ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false'] : []), ...(run.mcp?.args ?? [])],
    cwd: run.ctx.cwd,
    stdin: 'pipe',
    ...(run.mcp?.env ? { extraEnv: run.mcp.env } : {})
  })

  const live: WarmCodex = {
    key,
    sessionKey: run.req.sessionKey,
    handle,
    peer: null as unknown as JsonRpcPeer,
    threadId: '',
    primed: false,
    sink: null,
    items: new CodexItems(),
    diagnostics: [],
    failure: null,
    turnEnded: false,
    supportsVision: run.req.supportsVision ?? true,
    captureAgentTrace: run.req.captureAgentTrace === true,
    generation: 0,
    steered: [],
    pendingSteers: new Set(),
    turnImageCleanups: [],
    disposed: false
  }
  wire(live, handle, run)
  try {
    if (run.req.signal.aborted) throw new Error('cancelled')
    await handshake(live, run)
    return live
  } catch (err) {
    const wrapped = new Error(appServerFailure(err, live.diagnostics))
    dispose(live)
    throw wrapped
  }
}

function bindAbort(live: WarmCodex, signal: AbortSignal): void {
  const onAbort = (): void => dispose(live)
  if (signal.aborted) {
    dispose(live)
    return
  }
  signal.addEventListener('abort', onAbort, { once: true })
  live.unbind = () => signal.removeEventListener('abort', onAbort)
}

async function* runTurnOn(live: WarmCodex, run: AppServerRun, reuse: boolean): AsyncGenerator<ChatChunk> {
  if (live.disposed) throw new Error('codex app-server is no longer running')
  const generation = ++live.generation
  live.sink = new AsyncQueue()
  live.items = new CodexItems()
  live.failure = null
  live.turnEnded = false
  live.activeTurnId = undefined
  live.supportsVision = run.req.supportsVision ?? true
  live.captureAgentTrace = run.req.captureAgentTrace === true
  live.onTiming = run.req.onTiming
  live.steered = []
  live.turnImageCleanups = []
  live.approve = run.req.approve
  live.requestInput = run.req.requestInput
  live.diagnostics = []
  bindAbort(live, run.req.signal)

  const prompt = codexTurnPrompt(run.req.messages, run.req.sessionKey, live.primed)
  let releaseImages: () => Promise<void> = async () => undefined
  try {
    // Warm threads already have earlier images. Only this turn's pictures go out.
    const images = await materializeCodexImages(turnImages(run.req.messages, live.primed))
    releaseImages = images.cleanup
    noteTiming(run.req.onTiming, 'model-request')
    void live.peer
      .request('turn/start', {
        threadId: live.threadId,
        input: codexTurnItems(prompt, images.paths),
        // A resumed thread retains its old model unless the new turn
        // explicitly overrides it. Thread identity alone is not a model choice.
        ...(run.ctx.model && run.ctx.model !== 'default' ? { model: run.ctx.model } : {}),
        approvalPolicy: codexSafety(run.req).approvalPolicy,
        ...(codexSafety(run.req).approvalsReviewer ? { approvalsReviewer: codexSafety(run.req).approvalsReviewer } : {}),
        sandboxPolicy: codexSafety(run.req).sandbox === 'workspace-write'
          ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : { type: 'readOnly', networkAccess: false },
        // Per-turn override. A project config can ignore the thread config key,
        // and older servers ignore an effort they do not know.
        ...(run.ctx.effort ? { effort: run.ctx.effort } : {})
      })
      .catch((err: unknown) => {
        if (live.generation !== generation || live.disposed) return
        // `turn/start` settles when the turn is over. A completion we already
        // accepted must not tear the warm thread down.
        if (live.turnEnded && live.primed) return
        live.failure = err
        live.sink?.close()
      })

    for await (const chunk of live.sink) yield chunk
    // A steer acknowledged during completion must be recorded before the
    // watermark is frozen and before the next turn may begin.
    await Promise.allSettled([...live.pendingSteers])
    if (live.failure) throw live.failure
    if (!live.turnEnded || run.req.signal.aborted || live.disposed) return
    live.primed = true
    if (reuse) {
      rememberSent(run.req.sessionKey, fingerprints([...run.req.messages, ...live.steered]))
      await flushProviderBindings()
    }
    if (reuse) armIdle(live)
    yield { type: 'done' }
  } finally {
    // Images submitted during a live turn must remain readable by the CLI
    // until that turn stops, including when cancellation races an RPC.
    await Promise.allSettled([...live.pendingSteers])
    const imageCleanups = live.turnImageCleanups.splice(0)
    await Promise.allSettled(imageCleanups.map((cleanup) => cleanup()))
    const release = releaseImages
    releaseImages = async () => undefined
    await release()
    live.unbind?.()
    live.unbind = undefined
    live.approve = undefined
    live.requestInput = undefined
    const clean =
      reuse && live.turnEnded && live.primed && !live.failure && !run.req.signal.aborted && !live.disposed
    live.sink = null
    // Stop, a transport error, or a turn that never finished must not leave
    // the thread warm: the next message would send only the new line onto a
    // transcript Codex does not actually have.
    if (!clean) dispose(live)
    else trimIdleServers()
  }
}

/** Steer the one active Codex turn for this app conversation. */
export async function steerCodexTurn(sessionId: string, text: string, record: () => Promise<void>, message?: ProviderMessage | ((supportsVision: boolean) => ProviderMessage)): Promise<boolean> {
  const matches = [...warm.values()].filter((item) => item.sessionKey && sessionKeyMatches(item.sessionKey, sessionId) && item.sink && item.activeTurnId && !item.turnEnded && !item.disposed)
  if (matches.length !== 1) return false
  const live = matches[0]!
  const delivered: ProviderMessage = typeof message === 'function' ? message(live.supportsVision) : message ?? { role: 'user', content: text.trim() }
  const prompt = textOf(delivered.content)
  const imageParts = imagePartsOf(delivered.content)
  if ((!prompt.trim() && imageParts.length === 0) || imageParts.length > MAX_TURN_IMAGES) return false
  const turnId = live.activeTurnId!
  const operation = (async () => {
    const images = await materializeCodexImages(imageParts)
    if (images.paths.length !== imageParts.length || live.disposed || live.turnEnded || live.activeTurnId !== turnId) {
      await images.cleanup()
      return false
    }
    live.turnImageCleanups.push(images.cleanup)
    await withDeadline(live.peer.request('turn/steer', {
      threadId: live.threadId,
      expectedTurnId: turnId,
      input: codexTurnItems(prompt, images.paths)
    }), HANDSHAKE_TIMEOUT_MS, 'turn/steer')
    live.steered.push(delivered)
    await record()
    return true
  })()
  live.pendingSteers.add(operation)
  try {
    return await operation
  } finally {
    live.pendingSteers.delete(operation)
  }
}

function reusable(run: AppServerRun): boolean {
  return Boolean(run.req.sessionKey) && run.req.readOnly !== true
}

function identity(run: AppServerRun): CodexPoolIdentity {
  return {
    binaryPath: run.binaryPath,
    cwd: run.ctx.cwd,
    model: run.ctx.model,
    effort: run.ctx.effort ?? '',
    safety: JSON.stringify({ ...codexSafety(run.req), coordinatorOnly: run.req.coordinatorOnly === true }),
    sessionKey: run.req.sessionKey ?? '',
    args: run.mcp?.args ?? [],
    env: run.mcp?.env ?? {}
  }
}

function alive(live: WarmCodex): boolean {
  return (
    !live.disposed &&
    live.sink === null &&
    live.handle.child.exitCode === null &&
    live.handle.child.signalCode === null &&
    !live.handle.child.killed
  )
}

export async function* runCodexAppServer(run: AppServerRun): AsyncGenerator<ChatChunk> {
  if (run.req.disableNativeTools) throw new Error('Codex cannot safely disable its native host tools for this target')
  const keep = reusable(run)
  const key = keep ? codexPoolKey(identity(run)) : ''
  const existing = keep ? warm.get(key) : undefined
  if (existing && alive(existing)) {
    noteTiming(run.req.onTiming, 'warm-reused')
    if (existing.idle) {
      clearTimeout(existing.idle)
      existing.idle = undefined
      existing.idleSince = undefined
    }
    yield* runTurnOn(existing, run, true)
    return
  }
  if (existing) dispose(existing)

  const live = await boot(run, key)
  if (keep) warm.set(key, live)
  yield* runTurnOn(live, run, keep)
}

/** Readable reason when the server never starts. */
export function appServerFailure(err: unknown, diagnostics: string[]): string {
  const tail = diagnosticTail(diagnostics.join('\n'))
  const message = err instanceof Error ? err.message : String(err)
  return tail ? `${message}\n${tail}` : message
}
