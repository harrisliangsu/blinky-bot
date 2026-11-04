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
import { diagnosticTail } from '../secretRedaction'
import { type ProcessHandle, spawnLines } from '../spawnProcess'
import type { ChatChunk, ChatRequest } from '../types'
import {
  approvalResponse,
  CodexItems,
  codexNotification,
  describeApproval,
  isTurnEnd
} from './codexEvents'
import { type CodexPoolIdentity, codexPoolKey } from './codexPool'
import type { CliRunContext } from './spec'
import { codexTurnItems, materializeCodexImages, turnImages } from './cliImages'
import { codexTurnPrompt } from './transcript'

/**
 * Ceiling on the handshake. An app-server that starts and then never answers
 * `initialize` would leave the request pending forever.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000

/** Quiet period before a warm server is killed. Matches the gateway detach delay. */
const WARM_IDLE_MS = 120_000

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
  approve?: ChatRequest['approve']
  idle?: ReturnType<typeof setTimeout>
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
  live.unbind?.()
  live.unbind = undefined
  if (warm.get(live.key) === live) warm.delete(live.key)
  live.sink?.close()
  live.peer.close(new Error('codex app-server closed'))
  live.handle.kill()
}

function armIdle(live: WarmCodex): void {
  if (live.idle) clearTimeout(live.idle)
  live.idle = setTimeout(() => dispose(live), WARM_IDLE_MS)
  live.idle.unref?.()
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
        const chunks = codexNotification(method, params, live.items)
        for (const chunk of chunks) live.sink?.push(chunk)
        if (isTurnEnd(method)) {
          live.turnEnded = true
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
      const request = describeApproval(method, params, live.items)
      const approve = live.approve
      if (!request || !approve) return approvalResponse(method, params, 'reject')
      const decision = await approve(request)
      return approvalResponse(method, params, decision)
    })
  }

  // Codex asks the client to read files and fetch time; refuse politely rather
  // than leaving the request hanging and stalling the turn.
  live.peer.onRequest('item/tool/requestUserInput', () => ({ response: null }))

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

  const started = await withDeadline(
    live.peer.request<ThreadStarted>('thread/start', {
      cwd: run.ctx.cwd,
      ...(run.ctx.model && run.ctx.model !== 'default' ? { model: run.ctx.model } : {})
    }),
    HANDSHAKE_TIMEOUT_MS,
    'thread/start'
  )
  const threadId = started?.threadId ?? started?.thread?.id
  if (!threadId) throw new Error('codex app-server did not return a thread id')
  live.threadId = threadId
}

async function boot(run: AppServerRun, key: string): Promise<WarmCodex> {
  installExitHook()
  const handle = await spawnLines(run.binaryPath, {
    args: ['app-server', ...(run.mcp?.args ?? [])],
    cwd: run.ctx.cwd,
    stdin: 'pipe',
    ...(run.mcp?.env ? { extraEnv: run.mcp.env } : {})
  })

  const live: WarmCodex = {
    key,
    handle,
    peer: null as unknown as JsonRpcPeer,
    threadId: '',
    primed: false,
    sink: null,
    items: new CodexItems(),
    diagnostics: [],
    failure: null,
    turnEnded: false,
    generation: 0,
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
  live.approve = run.req.approve
  live.diagnostics = []
  bindAbort(live, run.req.signal)

  const prompt = codexTurnPrompt(live.primed, run.req.messages)
  let releaseImages: () => Promise<void> = async () => undefined
  try {
    // Warm threads already have earlier images. Only this turn's pictures go out.
    const images = await materializeCodexImages(turnImages(run.req.messages, live.primed))
    releaseImages = images.cleanup
    void live.peer
      .request('turn/start', {
        threadId: live.threadId,
        input: codexTurnItems(prompt, images.paths),
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
    if (live.failure) throw live.failure
    if (!live.turnEnded || run.req.signal.aborted || live.disposed) return
    live.primed = true
    if (reuse) armIdle(live)
    yield { type: 'done' }
  } finally {
    const release = releaseImages
    releaseImages = async () => undefined
    await release()
    live.unbind?.()
    live.unbind = undefined
    live.approve = undefined
    const clean =
      reuse && live.turnEnded && live.primed && !live.failure && !run.req.signal.aborted && !live.disposed
    live.sink = null
    // Stop, a transport error, or a turn that never finished must not leave
    // the thread warm: the next message would send only the new line onto a
    // transcript Codex does not actually have.
    if (!clean) dispose(live)
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
  const keep = reusable(run)
  const key = keep ? codexPoolKey(identity(run)) : ''
  const existing = keep ? warm.get(key) : undefined
  if (existing && alive(existing)) {
    if (existing.idle) {
      clearTimeout(existing.idle)
      existing.idle = undefined
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
