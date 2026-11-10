/**
 * Detection for agent CLIs: is the binary there, and does it answer?
 *
 * The probe is `<binary> --version` with stdin closed, classified as
 * missing / timeout / nonzero / success. Everything it needs comes from the
 * spec's install row, so detection stays data-driven.
 */

import type { CliAuthInfo } from '../../../shared/cliAuth'
import { installHint } from '../detectionTable'
import { checkInstall } from '../installStatus'
import type { DetectResult } from '../types'
import { probeVersion } from '../versionProbe'
import { probeCliAuth } from './authProbe'
import { type AgentCliSpec, commandFor } from './spec'
import type { BackendConfig } from '../types'

function signedOutDetail(spec: AgentCliSpec, command: string, version: string, where: string): string {
  if (spec.id === 'kimi') {
    return `${spec.displayName} is installed but not signed in. Run \`${command} login\` in a terminal, then refresh.`
  }
  if (spec.id === 'grok') {
    return `${spec.displayName} is installed but not signed in. Run \`${command} login\` in a terminal, or save an xAI API key on this row.`
  }
  return `${spec.displayName}${version} is installed${where} but has no configuration yet — run \`${command}\` once and sign in.`
}

function authDetail(
  spec: AgentCliSpec,
  auth: CliAuthInfo,
  command: string,
  version: string,
  where: string
): { status: DetectResult['status']; detail: string } {
  if (auth.state === 'logged-in') {
    if (spec.id === 'grok' && auth.account === 'API key') {
      return {
        status: 'available',
        detail: `${spec.displayName} is installed. The API key saved on this row is passed as XAI_API_KEY.`
      }
    }
    return { status: 'available', detail: `${spec.displayName}${version} found${where}.` }
  }
  if (auth.state === 'logged-out') {
    return { status: 'needs-key', detail: signedOutDetail(spec, command, version, where) }
  }
  return {
    status: 'error',
    detail: `${spec.displayName}${version} is installed${where}, but its sign-in state could not be checked.`
  }
}

export async function detectAgentCli(
  spec: AgentCliSpec,
  cfg: BackendConfig
): Promise<DetectResult> {
  const command = commandFor(spec, cfg)
  if (!command) {
    return {
      status: 'not-installed',
      detail: `Set a command for ${spec.displayName} in Settings — any binary speaking its protocol works.`
    }
  }

  // Resolve the binary first, then ask "what version?" and "signed in?" together.
  // Those used to run one after the other, so a Codex row paid two cold starts
  // (often several seconds) before Settings, or a background refresh, could move on.
  const located = await checkInstall(spec.install, { command, runVersionProbe: false })

  if (!located.installed || !located.binaryPath) {
    return {
      status: 'not-installed',
      detail: `\`${command}\` was not found on your PATH. ${installHint(spec.install)}`,
      cliAuth: { state: 'not-installed' }
    }
  }

  const binaryPath = located.binaryPath
  const [probe, cliAuth] = await Promise.all([
    probeVersion(binaryPath, spec.install.versionArgs ?? ['--version']),
    probeCliAuth(spec, cfg, binaryPath)
  ])

  if (probe.outcome === 'missing') {
    return {
      status: 'not-installed',
      detail: `\`${command}\` was not found on your PATH. ${installHint(spec.install)}`,
      cliAuth: { state: 'not-installed' }
    }
  }

  if (probe.outcome === 'timeout') {
    return {
      status: 'error',
      detail: `${spec.displayName} did not answer a version check within the probe window — it may be waiting on first-run setup. Run \`${command}\` once in a terminal.`,
      cliAuth
    }
  }

  if (probe.signal) {
    return {
      status: 'error',
      detail: `${spec.displayName} was terminated by ${probe.signal} during its version check. Its startup could not be verified; this does not establish a login failure.`,
      cliAuth
    }
  }

  const version = probe.version ? ` ${probe.version}` : ''
  const where = ` (${binaryPath})`
  const reported = authDetail(spec, cliAuth, command, version, where)
  return { ...reported, cliAuth }
}
