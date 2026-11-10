/**
 * Path resolution and workspace containment.
 *
 * Rules, in order:
 *   1. `~` expands to the current user's home directory (never hardcoded).
 *   2. A relative path resolves against `ctx.cwd` and may not climb out of it.
 *   3. An absolute path outside `ctx.cwd` goes through the approval policy.
 *      Auto-run allows directory access; other policies confirm it explicitly.
 *   4. Symlinks are re-checked after `realpath`, so a link inside the workspace
 *      cannot smuggle access to a target outside it.
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { approve } from './approval'
import { isInside } from './containment'
import { alreadyApproved, noteApprovedTarget, type AccessMode } from './grants'
import { ToolError } from './errors'
import { settingsOf } from './settings'
import type { ToolContext } from './types'
import { localExecutionPolicy } from '../../shared/localExecution'

export { isInside } from './containment'

export { forgetSession, noteApprovedTarget, type AccessMode } from './grants'

/** Directory access follows auto-run; this does not grant macOS privacy permissions. */
export function outsideAccessRequiresConfirmation(ctx: ToolContext): boolean {
  // The local switch now gates each call. Do not raise a second, broader
  // directory approval after the user has approved that exact operation.
  return localExecutionPolicy(settingsOf(ctx)) === 'never-allow'
}

/**
 * Every spelling of "home" a shell accepts, plus `$PWD`.
 *
 * Understanding only `~/` and `$HOME/` was a containment hole rather than a
 * cosmetic gap: `${HOME}` is what a model naturally emits, and each unhandled
 * form read as an ordinary relative path — resolving *inside* the workspace and
 * so raising no approval at all.
 *
 * A file genuinely named `$HOME` is pathological; reading these as home is both
 * the likely intent and the conservative one, since it can only add a prompt.
 */
export function expandHome(input: string, cwd?: string): string {
  const home = homedir()
  for (const [prefix, base] of [
    ['~', home],
    ['$HOME', home],
    ['${HOME}', home],
    ['$PWD', cwd ?? ''],
    ['${PWD}', cwd ?? '']
  ] as const) {
    if (!base) continue
    if (input === prefix) return base
    if (input.startsWith(`${prefix}/`) || input.startsWith(`${prefix}${sep}`)) {
      return join(base, input.slice(prefix.length + 1))
    }
  }

  // `~someone/…` — another account's home, which sits beside this one.
  const otherUser = /^~([^/\\]+)(.*)$/.exec(input)
  if (otherUser) return join(dirname(home), otherUser[1]!, otherUser[2]!.replace(/^[/\\]/, ''))

  return input
}


/** Workspace-relative form for display, or the absolute path when outside. */
export function displayPath(ctx: ToolContext, absolute: string): string {
  if (!isInside(ctx.cwd, absolute)) return absolute
  const rel = relative(ctx.cwd, absolute)
  return rel === '' ? '.' : rel
}

export interface ResolveOptions {
  /** Tool name, used in refusal messages and the approval prompt. */
  tool: string
  /** Reads ask with kind `fetch` (data leaving the workspace); writes with `write`. */
  mode: 'read' | 'write'
}

export interface ResolvedTarget {
  absolute: string
  /**
   * The path that falls outside the workspace, when one does and the session has
   * not already approved a root covering it. Undefined means "contained".
   */
  outside?: string
}

/**
 * Resolve a path **without** prompting, reporting whether it leaves the workspace.
 *
 * Tools that raise their own approval use this and fold `outside` into that one
 * request. A separate, earlier prompt would be worse than no prompt at all: the
 * executor's tool context latches on the first grant, so answering "read a path
 * outside the workspace" silently satisfies the approval for the diff or the
 * command that follows — the user would approve one thing and get another.
 */
export async function resolveTarget(
  ctx: ToolContext,
  input: string,
  opts: ResolveOptions
): Promise<ResolvedTarget> {
  const raw = expandHome(input.trim())
  if (raw === '') throw new ToolError(`${opts.tool}: the "path" argument is empty.`)

  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw)

  if (!isAbsolute(raw) && !isInside(ctx.cwd, absolute)) {
    throw new ToolError(
      `${opts.tool}: the relative path "${input}" escapes the working directory.`,
      'Stay inside the workspace, or pass a full absolute path if you genuinely need to reach outside it — the user will be asked to approve that.'
    )
  }

  if (!isInside(ctx.cwd, absolute)) {
    return alreadyApproved(ctx.sessionId, absolute, opts.mode) ? { absolute } : { absolute, outside: absolute }
  }

  // Lexically contained — but a symlink may still point somewhere else. Both
  // sides are resolved before comparing, because the workspace itself usually
  // sits under a symlinked ancestor on macOS (/tmp, /var and /etc all are).
  const [realCwd, realTarget] = await Promise.all([realCwdOf(ctx.cwd), resolveReal(absolute)])
  if (!isInside(realCwd, realTarget) && !alreadyApproved(ctx.sessionId, realTarget, opts.mode)) {
    return { absolute, outside: realTarget }
  }
  return { absolute }
}

/**
 * Resolve a model-supplied path to an absolute one, enforcing the rules above.
 * Throws a `ToolError` when the path is refused.
 *
 * For tools that raise no approval of their own. Anything that describes its own
 * action must use {@link resolveTarget} instead — see the note there.
 */
export async function resolvePath(ctx: ToolContext, input: string, opts: ResolveOptions): Promise<string> {
  const target = await resolveTarget(ctx, input, opts)
  if (target.outside) {
    const tool = target.outside === target.absolute ? opts.tool : `${opts.tool} (symlink target)`
    await ensureAllowed(ctx, target.outside, { ...opts, tool })
  }
  return target.absolute
}

/**
 * The block a self-approving tool pastes into its own approval detail, so the
 * one card the user answers says plainly that the action leaves the workspace.
 */
export function outsideNotice(ctx: ToolContext, outside: string): string {
  return ['OUTSIDE THE WORKSPACE', `Path:      ${outside}`, `Workspace: ${ctx.cwd}`].join('\n')
}

/**
 * Which of `candidates` fall outside the workspace and are not already approved.
 *
 * For a tool whose target is a whole command line rather than one path — the
 * classifier can call `cat` read-only all it likes, but `cat ~/.ssh/id_rsa`
 * still leaves the workspace, and that is the containment the file tools
 * enforce. Unresolvable or nonexistent paths are reported rather than skipped:
 * the point is what the command *names*, not what exists right now.
 */
export async function escapingPaths(ctx: ToolContext, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return []
  const realCwd = await realCwdOf(ctx.cwd)
  const out: string[] = []

  for (const candidate of candidates) {
    const raw = expandHome(candidate.trim(), ctx.cwd)
    if (!raw) continue
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw)

    /*
     * No lexical short-circuit. A path that *looks* contained can still be a
     * symlink pointing out of the workspace, which is the whole reason the
     * file tools re-check after `realpath` — skipping the check for anything
     * lexically inside would reopen the escape one layer down.
     */
    const real = await resolveReal(absolute)
    if (isInside(realCwd, real) || alreadyApproved(ctx.sessionId, real, 'read')) continue
    if (!out.includes(real)) out.push(real)
  }
  return out
}

/** `realpath` of the workspace root, resolved once per directory. */
const realCwdCache = new Map<string, string>()

async function realCwdOf(cwd: string): Promise<string> {
  const cached = realCwdCache.get(cwd)
  if (cached !== undefined) return cached
  const real = await resolveReal(cwd)
  realCwdCache.set(cwd, real)
  return real
}

/**
 * Real path of `target`, tolerating a file that does not exist yet: the deepest
 * existing ancestor is resolved and the remaining segments are re-appended, so
 * a symlinked parent is still detected for a file that is about to be created.
 *
 * Without this, `realpath` throws ENOENT on a path being created and a fallback
 * to the literal path lets a symlinked *parent* smuggle a write outside the
 * workspace: with `link -> /etc` inside the workspace, `link/passwd` looks
 * contained lexically and never triggers an approval.
 */
async function resolveReal(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    const parent = dirname(target)
    if (parent === target) return target
    return join(await resolveReal(parent), basename(target))
  }
}

/**
 * Stable physical destination for a read or write, including a target that does
 * not exist yet. Mutation code commits to this path rather than following the
 * model-supplied symlink a second time after approval.
 */
export async function resolvedTargetPath(target: string): Promise<string> {
  return resolveReal(resolve(target))
}

/**
 * Containment result for a physical path that has already been resolved and
 * locked by the mutation layer. This avoids following a model-supplied symlink
 * again between the outside-workspace gate and reading the approved preview.
 */
export async function outsideResolvedTarget(
  ctx: ToolContext,
  resolvedPath: string,
  mode: AccessMode
): Promise<string | undefined> {
  const realCwd = await realCwdOf(ctx.cwd)
  if (isInside(realCwd, resolvedPath) || alreadyApproved(ctx.sessionId, resolvedPath, mode)) {
    return undefined
  }
  return resolvedPath
}

async function ensureAllowed(ctx: ToolContext, absolute: string, opts: ResolveOptions): Promise<void> {
  if (isInside(ctx.cwd, absolute)) return
  if (alreadyApproved(ctx.sessionId, absolute, opts.mode)) return

  const verb = opts.mode === 'write' ? 'Write to' : 'Read'
  const granted = await approve(
    ctx,
    {
      toolName: opts.tool,
      kind: opts.mode === 'write' ? 'write' : 'fetch',
      summary: `${verb} a path outside the workspace`,
      detail: [`Path:      ${absolute}`, `Workspace: ${ctx.cwd}`, '', `Requested by: ${opts.tool}`].join('\n')
    },
    // Still reach the gate so explicit deny rules apply in auto-run as well.
    { force: outsideAccessRequiresConfirmation(ctx) }
  )

  if (!granted) {
    throw new ToolError(
      `${opts.tool}: access to "${absolute}" was refused — it is outside the workspace (${ctx.cwd}).`,
      'Work inside the workspace instead, or ask the user to open that folder as the working directory.'
    )
  }
  noteApprovedTarget(ctx, absolute, opts.mode)
}
