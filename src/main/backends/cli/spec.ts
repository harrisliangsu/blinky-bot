/**
 * The agent-CLI data spec.
 *
 * Each supported CLI is a row: its binary, how to install it, and the few
 * transport knobs its runtime needs. A CLI compatible with one we already
 * support costs a spec row plus a stdout mapper, not a new transport.
 */

import type { InstallSpec } from '../detectionTable'
import type { BackendConfig, ModelInfo } from '../types'
import { which } from '../which'

export interface AgentCliSpec {
  id: string
  displayName: string
  /** Bare name, resolved through the hydrated login-shell PATH. */
  defaultBinaryPath: string
  install: InstallSpec
  /** Server transport: the stdout line that announces readiness. */
  serverReadyPrefix?: string
  /** Config directory name under the user's home, for status detail. */
  dataDirectoryName?: string
  /** Server transport: basic-auth username when a server password is set. */
  serverAuthUsername?: string
}

/** Everything a single run needs to know. */
export interface CliRunContext {
  /** Model slug as the CLI names it, or `default` to let the CLI choose. */
  model: string
  cwd: string
  extraArgs: string[]
  /** Codex reasoning effort for this thread, when the Bot picked a depth. */
  effort?: string
}

export interface CliOptions {
  cwd: string
  extraArgs: string[]
  /** ACP only: let the agent's mutating tools run unattended. */
  allowWrites: boolean
}

/**
 * Two conventions are read out of `BackendConfig.extraArgs`:
 *   `--cwd <path>`   override the session's folder for this backend
 *   `--allow-writes` ACP agents may run mutating tools without asking
 * Everything else is passed through to the CLI untouched.
 */
export function readCliOptions(cfg: BackendConfig, sessionCwd?: string): CliOptions {
  const args = cfg.extraArgs ?? []
  const extraArgs: string[] = []
  /*
   * The session's folder wins. `process.cwd()` is only a last resort: it is
   * wherever Electron happened to be launched from, which has nothing to do
   * with the work the user is asking for.
   */
  let cwd = sessionCwd?.trim() || process.cwd()
  let allowWrites = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      cwd = args[++i]
      continue
    }
    if (args[i] === '--allow-writes') {
      allowWrites = true
      continue
    }
    extraArgs.push(args[i])
  }
  return { cwd, extraArgs, allowWrites }
}

export function commandFor(spec: AgentCliSpec, cfg: BackendConfig): string {
  return cfg.command?.trim() || spec.defaultBinaryPath
}

/** Full path to the CLI, or the bare command if PATH lookup came up empty. */
export async function resolveBinary(spec: AgentCliSpec, cfg: BackendConfig): Promise<string> {
  const command = commandFor(spec, cfg)
  if (!command) throw new Error(`Set a command for ${spec.displayName} in Settings.`)
  return (await which(command)) ?? command
}

export function runContext(model: string, opts: CliOptions, effort?: string): CliRunContext {
  return { model: model || 'default', cwd: opts.cwd, extraArgs: opts.extraArgs, ...(effort ? { effort } : {}) }
}

/** Only pass a model flag when the user picked something concrete. */
export function modelFlag(flag: string, ctx: CliRunContext): string[] {
  return ctx.model && ctx.model !== 'default' ? [flag, ctx.model] : []
}

/** Placeholder entry meaning "whatever the CLI is configured to use". */
export const CLI_DEFAULT_MODEL: ModelInfo = {
  id: 'default',
  label: 'CLI default model',
  supportsTools: true,
  supportsVision: true
}
