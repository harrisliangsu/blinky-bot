/**
 * Codex over `app-server` — a persistent, session-based transport.
 *
 * Unlike one-shot `codex exec`, the app server keeps a thread alive and asks
 * the CLIENT before running commands or editing files. Those requests are
 * routed to OpenBOT's approval gate, which is the entire reason for preferring
 * this path. It is marked experimental upstream, so `codex.ts` falls back to
 * `exec` when this fails to start.
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

/**
 * Ceiling on the handshake. `codex.ts` falls back to one-shot `exec` when this
 * transport fails, but an app-server that starts and then never answers
 * `initialize` would leave the request pending forever and the fallback would
 * never run — the turn would just hang.
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

interface ThreadStarted {
  threadId?: string
  thread?: { id?: string }
}

export interface AppServerRun {
  binaryPath: string
  ctx: CliRunContext
  prompt: string
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

    const started = await withDeadline(
      peer.request<ThreadStarted>('thread/start', {
        cwd: run.ctx.cwd,
        ...(run.ctx.model && run.ctx.model !== 'default' ? { model: run.ctx.model } : {})
      }),
      HANDSHAKE_TIMEOUT_MS,
      'thread/start'
    )
    const threadId = started?.threadId ?? started?.thread?.id
    if (!threadId) throw new Error('codex app-server did not return a thread id')

    // Not awaited: the turn's output arrives as notifications, and this request
    // only settles when the turn is already over.
    void peer
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: run.prompt }]
      })
      .catch((err) => {
        failure = err
        chunks.close()
      })

    for await (const chunk of chunks) yield chunk
    if (failure) throw failure
    yield { type: 'done' }
  } finally {
    run.req.signal.removeEventListener('abort', abort)
    peer.close()
    handle.kill()
    await pump.catch(() => {})
  }
}

/** Readable reason for the fallback path to report if the server never starts. */
export function appServerFailure(err: unknown, diagnostics: string[]): string {
  const tail = diagnosticTail(diagnostics.join('\n'))
  const message = err instanceof Error ? err.message : String(err)
  return tail ? `${message}\n${tail}` : message
}
