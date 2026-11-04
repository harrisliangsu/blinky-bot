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

  const install = await checkInstall(spec.install, { command, runVersionProbe: true })

  if (!install.installed || !install.binaryPath) {
    return {
      status: 'not-installed',
      detail: `\`${command}\` was not found on your PATH. ${installHint(spec.install)}`,
      cliAuth: { state: 'not-installed' }
    }
  }

  if (install.outcome === 'timeout') {
    return {
      status: 'error',
      detail: `${spec.displayName} did not answer a version check within the probe window — it may be waiting on first-run setup. Run \`${command}\` once in a terminal.`,
      cliAuth: { state: 'unknown' }
    }
  }

  const version = install.version ? ` ${install.version}` : ''
  const where = ` (${install.binaryPath})`
  const cliAuth = await probeCliAuth(spec, cfg, install.binaryPath)
  const reported = authDetail(spec, cliAuth, command, version, where)
  return { ...reported, cliAuth }
}
