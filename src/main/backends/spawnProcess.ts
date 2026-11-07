/**
 * Child-process spawning for agent CLIs.
 *
 * Every child runs with the hydrated login-shell environment, is cancellable
 * through an `AbortSignal`, and exposes stdout/stderr as an async iterable of
 * lines (the transport every agent CLI protocol is built on).
 *
 * Children lead their own process group so that cancelling a turn takes the
 * CLI's descendants with it. Every agent CLI here is reached through a wrapper
 * — an npm bin shim, `~/.local/bin/droid`, a node launcher — so the process
 * that does the work is a grandchild, and signalling only the direct child
 * leaves it running against the user's quota.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { AsyncQueue } from './asyncQueue'
import { LineSplitter } from './lineStream'
import { hydratedEnv } from './loginShellEnv'
import { noteTiming, type TimingObserver } from './chatTiming'

/** Grace between SIGTERM and SIGKILL for a child that ignores the first. */
const KILL_GRACE_MS = 2_000

export interface ProcessLine {
  stream: 'stdout' | 'stderr'
  line: string
}

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface SpawnLinesOptions {
  onTiming?: TimingObserver
  args?: string[]
  cwd?: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /**
   * Merged over the hydrated environment rather than replacing it.
   *
   * How a per-turn secret reaches a CLI that reads its credentials from the
   * environment: it stays out of argv, so it is never in the process listing.
   */
  extraEnv?: NodeJS.ProcessEnv
  /** `ignore` closes stdin immediately (probes); `pipe` keeps it writable. */
  stdin?: 'ignore' | 'pipe'
  /** Wall-clock ceiling. The process group is killed once it elapses. */
  timeoutMs?: number
}

export interface ProcessHandle {
  child: ChildProcess
  lines: AsyncIterable<ProcessLine>
  write(text: string): void
  closeStdin(): void
  kill(signal?: NodeJS.Signals): void
  exit: Promise<ExitInfo>
  /** True once `timeoutMs` elapsed and the process was killed for it. */
  timedOut(): boolean
  /** The first failure writing to stdin, if the pipe broke. */
  stdinError(): Error | null
}

export async function spawnLines(bin: string, opts: SpawnLinesOptions = {}): Promise<ProcessHandle> {
  noteTiming(opts.onTiming, 'environment-start')
  const base = opts.env ?? (await hydratedEnv())
  const env = opts.extraEnv ? { ...base, ...opts.extraEnv } : base
  noteTiming(opts.onTiming, 'environment-ready')
  // `detached` calls setsid(), making the child a process-group leader so the
  // whole tree can be signalled with process.kill(-pid). Not available on Win32.
  const ownGroup = process.platform !== 'win32'
  noteTiming(opts.onTiming, 'process-spawn-start')
  const child = spawn(bin, opts.args ?? [], {
    cwd: opts.cwd,
    env,
    stdio: [opts.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: ownGroup
  })
  child.once('spawn', () => noteTiming(opts.onTiming, 'process-spawned'))

  const queue = new AsyncQueue<ProcessLine>()
  const outSplitter = new LineSplitter()
  const errSplitter = new LineSplitter()

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    for (const line of outSplitter.push(chunk)) queue.push({ stream: 'stdout', line })
  })
  child.stderr?.on('data', (chunk: string) => {
    for (const line of errSplitter.push(chunk)) queue.push({ stream: 'stderr', line })
  })

  /*
   * A child that has already exited turns the next stdin write into EPIPE, and
   * a stream with no `error` listener rethrows that as an uncaughtException —
   * taking the failure out of the turn's hands entirely. `crashGuards` catches
   * it, but by its own docstring that means carrying on with invariants that
   * may no longer hold, when the honest outcome is a turn that failed.
   *
   * It is not an edge case: `stdioJson` writes the whole transcript
   * immediately after spawn, so every CLI that dies at once — not logged in,
   * bad flag, wrong binary — reaches this. Remembered rather than thrown,
   * because the child's own exit code and stderr usually say something far
   * more useful about why the pipe went away.
   */
  let pipeError: Error | null = null
  child.stdin?.on('error', (err: Error) => {
    pipeError ??= err
  })

  let settle: (info: ExitInfo) => void = () => undefined
  const exit = new Promise<ExitInfo>((resolve) => {
    settle = resolve
  })

  let gone = false
  let timedOut = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let runTimer: ReturnType<typeof setTimeout> | undefined

  /** Signal the whole group, falling back to the bare child. */
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (gone || typeof child.pid !== 'number') return
    try {
      if (ownGroup) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // Already reaped.
      }
    }
  }

  /*
   * SIGTERM first so the CLI can flush, then SIGKILL. Without the escalation a
   * CLI that traps TERM never exits, `exit` never settles, and the caller waits
   * on a promise that can no longer resolve.
   */
  const terminate = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    if (gone) return
    signalGroup(signal)
    if (signal === 'SIGKILL' || graceTimer) return
    graceTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    graceTimer.unref?.()
  }

  const cleanup = (): void => {
    gone = true
    if (graceTimer) clearTimeout(graceTimer)
    if (runTimer) clearTimeout(runTimer)
    graceTimer = undefined
    runTimer = undefined
    opts.signal?.removeEventListener('abort', onAbort)
  }

  function onAbort(): void {
    terminate()
  }

  // An abort that already happened fires no event: addEventListener on a
  // settled signal is a no-op, which would leave the child running forever.
  if (opts.signal) {
    if (opts.signal.aborted) queueMicrotask(onAbort)
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    runTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)
    runTimer.unref?.()
  }

  child.on('error', (error: Error) => {
    cleanup()
    queue.close(error)
    settle({ code: null, signal: null, error })
  })

  child.on('close', (code, signal) => {
    cleanup()
    for (const line of outSplitter.flush()) queue.push({ stream: 'stdout', line })
    for (const line of errSplitter.flush()) queue.push({ stream: 'stderr', line })
    queue.close()
    settle({ code, signal })
  })

  return {
    child,
    lines: queue,
    /*
     * `writable` is checked and can still be stale: the child may exit between
     * the check and the write, which throws synchronously rather than emitting
     * on the stream. Same failure, same handling.
     */
    write(text: string) {
      if (!child.stdin?.writable) return
      try {
        child.stdin.write(text)
      } catch (err) {
        pipeError ??= err as Error
      }
    },
    closeStdin() {
      if (!child.stdin?.writable) return
      try {
        child.stdin.end()
      } catch (err) {
        pipeError ??= err as Error
      }
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      terminate(signal)
    },
    exit,
    timedOut: () => timedOut,
    stdinError: () => pipeError
  }
}
