/**
 * The line-delimited-JSON transport: run the CLI for one turn, write the prompt
 * to stdin, translate its stdout events, and kill it when the turn ends.
 *
 * Shared by every CLI whose non-interactive mode prints one JSON object per
 * line (Claude Code, Droid, pi).
 */

import { safeJsonParse } from '../lenientJson'
import { diagnosticTail } from '../vaultRedaction'
import { type ExitInfo, spawnLines } from '../spawnProcess'
import type { ChatChunk } from '../types'
import type { EventMapper } from './events'
import type { AgentCliSpec, CliRunContext } from './spec'
import { noteTiming, type TimingObserver } from '../chatTiming'

export interface StdioJsonRun {
  onTiming?: TimingObserver
  spec: AgentCliSpec
  binaryPath: string
  args: string[]
  ctx: CliRunContext
  prompt: string
  /**
   * `json` writes one encoded line; `text` writes the raw prompt.
   * `none` only closes stdin — the prompt already went out as an argv or a file,
   * which is how Kimi (`-p`) and Grok (`--prompt-file`) take it.
   */
  promptInput: 'stdin-json' | 'stdin-text' | 'none'
  encodePrompt?: (prompt: string) => string
  mapper: EventMapper
  signal: AbortSignal
  /** Merged over the hydrated shell environment — per-turn credentials. */
  extraEnv?: Record<string, string>
  /** Wall-clock ceiling for this turn. Defaults to `TURN_TIMEOUT_MS`. */
  timeoutMs?: number
}

/**
 * Wall-clock ceiling on one CLI turn.
 *
 * `spawnLines` has always accepted `timeoutMs` and this transport never passed
 * one, which made the `timedOut()` branch below unreachable: a CLI that started
 * and then hung — waiting on a login prompt nothing will answer, on a network
 * call with no timeout of its own, on a lock it will never get — left the turn
 * pending forever, with the user's own cancel as the only way out. Generous
 * enough that a long agentic turn finishes well inside it.
 */
const TURN_TIMEOUT_MS = 30 * 60_000

/**
 * Ring-buffer bound on kept diagnostics.
 *
 * Only `diagnosticTail` — the last ~1200 characters — is ever reported, but
 * every stderr line and every non-JSON stdout line was retained for the whole
 * turn. A CLI that logs per token grew that array without limit for output
 * nothing would ever read. `serverPool` already bounds its own the same way.
 */
const MAX_DIAGNOSTIC_LINES = 200

function describeExit(info: ExitInfo): string {
  if (info.error) return `failed to start (${info.error.message})`
  if (info.signal) return `was stopped by ${info.signal}`
  return `exited with code ${info.code}`
}

export async function* runStdioJson(run: StdioJsonRun): AsyncGenerator<ChatChunk> {
  const handle = await spawnLines(run.binaryPath, {
    onTiming: run.onTiming,
    args: run.args,
    cwd: run.ctx.cwd,
    signal: run.signal,
    stdin: 'pipe',
    timeoutMs: run.timeoutMs ?? TURN_TIMEOUT_MS,
    ...(run.extraEnv ? { extraEnv: run.extraEnv } : {})
  })

  try {
    if (run.promptInput !== 'none') {
      noteTiming(run.onTiming, 'model-request')
      const payload =
        run.promptInput === 'stdin-json' && run.encodePrompt
          ? `${run.encodePrompt(run.prompt)}\n`
          : run.prompt.endsWith('\n')
            ? run.prompt
            : `${run.prompt}\n`
      handle.write(payload)
    }
    handle.closeStdin()

    const diagnostics: string[] = []
    const note = (line: string): void => {
      diagnostics.push(line)
      if (diagnostics.length > MAX_DIAGNOSTIC_LINES) diagnostics.shift()
    }

    for await (const { stream, line } of handle.lines) {
      if (!line.trim()) continue
      if (stream === 'stderr') {
        note(line)
        continue
      }
      const value = safeJsonParse<unknown>(line)
      if (value === undefined) {
        // Non-JSON stdout is progress noise; keep it only for error reporting.
        note(line)
        continue
      }
      for (const chunk of run.mapper(value)) yield chunk
    }

    /*
     * The exit code decides, not whether anything was said.
     *
     * A CLI that streams half an answer and then dies — `FATAL: out of quota`
     * on stderr, exit 3 — has failed, and the half it managed to say is the
     * most misleading possible thing to show: the user reads a truncated answer
     * as a complete one. Guarding this on "produced nothing" only caught the
     * CLIs that failed before saying anything at all. What was already streamed
     * is kept by the caller; this only makes sure the failure is reported too.
     */
    const info = await handle.exit
    /*
     * A broken stdin pipe fails the turn on its own, when the prompt went
     * through stdin. `promptInput: 'none'` already delivered it as argv or a
     * file, so closing the unused pipe is not a failed prompt.
     */
    const pipeError = run.promptInput === 'none' ? null : handle.stdinError()
    if (!run.signal.aborted && (info.error || pipeError || info.code !== 0)) {
      const tail = diagnosticTail(diagnostics.join('\n'))
      const reason = handle.timedOut()
        ? 'timed out and was killed'
        : info.error || info.code !== 0
          ? describeExit(info)
          : `could not be given the prompt (${pipeError?.message ?? 'stdin closed'})`
      throw new Error(`${run.spec.displayName} ${reason}${tail ? `:\n${tail}` : '.'}`)
    }
    yield { type: 'done' }
  } finally {
    handle.kill()
  }
}

export interface CapturedCli {
  code: number | null
  /** stdout only — the stream a parser should ever look at. */
  stdout: string
  stderr: string
  /** Both streams, in arrival order. For diagnostics, never for parsing. */
  output: string
}

/** Cap on captured output, so a chatty CLI cannot grow the heap without bound. */
const MAX_CAPTURE_LINES = 20_000

/**
 * Run a CLI to completion and capture its output. Used for model listing.
 *
 * stdout and stderr are kept apart: they are interleaved non-deterministically,
 * and folding a stderr warning into stdout corrupts whatever table the caller
 * is about to parse.
 */
export async function captureCli(
  binaryPath: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000
): Promise<CapturedCli> {
  try {
    const handle = await spawnLines(binaryPath, {
      args,
      cwd,
      stdin: 'ignore',
      timeoutMs
    })
    const out: string[] = []
    const err: string[] = []
    const both: string[] = []
    const drain = (async () => {
      for await (const { stream, line } of handle.lines) {
        if (both.length >= MAX_CAPTURE_LINES) continue
        both.push(line)
        ;(stream === 'stdout' ? out : err).push(line)
      }
    })().catch(() => undefined)
    const info = await handle.exit
    await drain
    return {
      code: info.code,
      stdout: out.join('\n'),
      stderr: err.join('\n'),
      output: both.join('\n')
    }
  } catch {
    return { code: null, stdout: '', stderr: '', output: '' }
  }
}
