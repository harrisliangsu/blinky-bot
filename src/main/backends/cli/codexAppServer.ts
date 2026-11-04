/**
 * Codex over `app-server` — one process per turn, one thread across turns.
 *
 * Unlike one-shot `codex exec`, the app server asks the CLIENT before running
 * commands or editing files. Those requests are routed to OpenBOT's approval
 * gate, which is the entire reason for preferring this path.
 *
 * The process is not kept alive between turns. Codex persists the thread
 * itself; `thread/resume` loads it by id into the next process. A long-lived
 * server is not required by the public API, and it would outlive this turn's
 * abort signal and approval callback. The id is stored in provider bindings.
 * The first turn calls `thread/start`. Later turns call `thread/resume`.
 *
 * A failed resume drops that binding and starts a fresh thread with the in-app
 * transcript. Reconnect notifications (`error` with `willRetry: true`) are not
 * resume failures — `codexEvents` keeps those turns alive and must not abort.
 */

import { AsyncQueue } from '../asyncQueue'
import { JsonRpcPeer } from '../jsonRpc'
import { diagnosticTail } from '../secretRedaction'
import { spawnLines } from '../spawnProcess'
import type { ChatChunk, ChatRequest } from '../types'
import {
  approvalResponse,
  CodexItems,
  codexNotification,
  describeApproval,
  isTurnEnd
} from './codexEvents'
import type { CliRunContext } from './spec'
import {
  codexThreadCall,
  codexTurnPrompt,
  forgetCodexThread,
  rememberCodexThread,
  rememberedCodexThread,
  shouldRetryCodexThread,
  threadIdOf
} from './codexThread'
import { fingerprints, rememberSent } from './resumePrompt'

/**
 * Ceiling on the handshake. `codex.ts` fails the turn when this transport
 * cannot start, but an app-server that starts and then never answers
 * `initialize` would leave the request pending forever — the turn would hang
 * instead of reporting that failure.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000

/**
 * Ring-buffer bound on kept diagnostics. Only `diagnosticTail` — the last
 * ~1200 characters — is ever reported, but every stderr line was retained for
 * the whole turn, so a chatty server grew the array without limit for output
 * nothing would read. `serverPool` already bounds its own the same way.
 */
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

interface ThreadOpened {
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

export async function* runCodexAppServer(run: AppServerRun): AsyncGenerator<ChatChunk> {
  const handle = await spawnLines(run.binaryPath, {
    args: ['app-server', ...(run.mcp?.args ?? [])],
    cwd: run.ctx.cwd,
    signal: run.req.signal,
    stdin: 'pipe',
    ...(run.mcp?.env ? { extraEnv: run.mcp.env } : {})
  })

  const chunks = new AsyncQueue<ChatChunk>()
  const diagnostics: string[] = []
  const note = (line: string): void => {
    diagnostics.push(line)
    if (diagnostics.length > MAX_DIAGNOSTIC_LINES) diagnostics.shift()
  }
  /*
   * An approval request names an item; what that item is about was said
   * earlier, in the notification stream. Without this the file-change dialog
   * had nothing to show the user but the word "files".
   */
  const items = new CodexItems()
  let failure: unknown = null
  let turnEnded = false

  const peer = new JsonRpcPeer(
    (line) => handle.write(`${line}\n`),
    (method, params) => {
      try {
        for (const chunk of codexNotification(method, params, items)) chunks.push(chunk)
        if (isTurnEnd(method)) {
          turnEnded = true
          chunks.close()
        }
      } catch (err) {
        failure = err
        chunks.close()
      }
    }
  )

  /*
   * Fail CLOSED, on both counts. If the loop gave us no way to ask the user,
   * deny rather than letting the CLI run commands unattended — an unattended
   * `approve` here would be a silent privilege escalation. And if the request
   * cannot be described, deny too: an approval dialog that cannot say what it
   * is approving is not consent, and the denylist has nothing to match against.
   */
  for (const method of APPROVAL_METHODS) {
    peer.onRequest(method, async (params) => {
      const request = describeApproval(method, params, items)
      if (!request || !run.req.approve) return approvalResponse(method, params, 'reject')
      const decision = await run.req.approve(request)
      return approvalResponse(method, params, decision)
    })
  }

  // Codex asks the client to read files and fetch time; refuse politely rather
  // than leaving the request hanging and stalling the turn.
  peer.onRequest('item/tool/requestUserInput', () => ({ response: null }))

  /*
   * The rejection handler is attached here, not at the `await` in the `finally`
   * below: a child that fails to spawn rejects this immediately, and a promise
   * that stays unhandled until then is an unhandledRejection in the main
   * process.
   *
   * When the loop ends, the child's streams are closed and no further
   * notification can arrive. If the turn never reached `turn/completed`, the
   * queue has to be closed with a reason — otherwise the generator below waits
   * on a queue nothing will ever push to, and the turn hangs forever.
   */
  const pump = (async () => {
    for await (const { stream, line } of handle.lines) {
      if (stream === 'stdout') peer.handleLine(line)
      else if (line.trim()) note(line)
    }
  })()
    .catch((err: unknown) => {
      failure ??= err
    })
    .finally(() => {
      if (!turnEnded && failure === null && !run.req.signal.aborted) {
        failure = new Error(
          appServerFailure(new Error('codex app-server stopped before the turn finished'), diagnostics)
        )
      }
      peer.close(failure ?? new Error('codex app-server closed'))
      chunks.close()
    })

  const abort = (): void => {
    peer.close(new Error('cancelled'))
    chunks.close()
    handle.kill()
  }
  run.req.signal.addEventListener('abort', abort, { once: true })

  try {
    await withDeadline(
      peer.request('initialize', {
        clientInfo: { name: 'BlinkyBot', title: 'BlinkyBot', version: '0.1.0' }
      }),
      HANDSHAKE_TIMEOUT_MS,
      'initialize'
    )

    const opened = await openCodexThread(peer, run, rememberedCodexThread(run.req.sessionKey))
    const threadId = opened.threadId
    const prompt = codexTurnPrompt(run.req.messages, run.req.sessionKey, opened.resumed)
    if (!prompt.trim()) throw new Error('Codex was given an empty prompt.')

    // Not awaited: the turn's output arrives as notifications, and this request
    // only settles when the turn is already over.
    void peer
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }]
      })
      .catch((err) => {
        failure = err
        chunks.close()
      })

    for await (const chunk of chunks) yield chunk
    if (failure) throw failure
    rememberSent(run.req.sessionKey, fingerprints(run.req.messages))
    yield { type: 'done' }
  } finally {
    run.req.signal.removeEventListener('abort', abort)
    peer.close()
    handle.kill()
    await pump.catch(() => {})
  }
}

async function openCodexThread(
  peer: { request: <T>(method: string, params?: unknown) => Promise<T> },
  run: AppServerRun,
  existingThreadId: string | undefined
): Promise<{ threadId: string; resumed: boolean }> {
  if (existingThreadId) {
    const call = codexThreadCall({ threadId: existingThreadId, cwd: run.ctx.cwd, model: run.ctx.model })
    try {
      const resumed = await withDeadline(
        peer.request<ThreadOpened>(call.method, call.params),
        HANDSHAKE_TIMEOUT_MS,
        call.method
      )
      const threadId = threadIdOf(resumed) ?? existingThreadId
      rememberCodexThread(run.req.sessionKey, threadId)
      return { threadId, resumed: true }
    } catch (err) {
      if (!shouldRetryCodexThread({ hadThread: true, aborted: run.req.signal.aborted })) throw err
      forgetCodexThread(run.req.sessionKey)
    }
  }

  const call = codexThreadCall({ cwd: run.ctx.cwd, model: run.ctx.model })
  const started = await withDeadline(
    peer.request<ThreadOpened>(call.method, call.params),
    HANDSHAKE_TIMEOUT_MS,
    call.method
  )
  const threadId = threadIdOf(started)
  if (!threadId) throw new Error('codex app-server did not return a thread id')
  rememberCodexThread(run.req.sessionKey, threadId)
  return { threadId, resumed: false }
}

/** Readable reason for the fallback path to report if the server never starts. */
export function appServerFailure(err: unknown, diagnostics: string[]): string {
  const tail = diagnosticTail(diagnostics.join('\n'))
  const message = err instanceof Error ? err.message : String(err)
  return tail ? `${message}\n${tail}` : message
}
