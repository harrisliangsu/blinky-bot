/**
 * Ask one installed CLI whether it is signed in.
 *
 * The status command is the CLI's own. When it has none, or this version
 * does not provide it, only the presence of the documented credential file
 * (or a documented env var name) is checked. Kimi also supports API credentials
 * in its native providers configuration; project that CLI output to a boolean
 * without returning or persisting credential values.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { CliAuthInfo } from '../../../shared/cliAuth'
import type { BackendConfig } from '../types'
import { hydratedEnv } from '../loginShellEnv'
import { spawnLines } from '../spawnProcess'
import {
  type CommandObservation,
  PI_AUTH_ENV,
  type PresenceObservation,
  authMethod,
  commandUnrecognized,
  interpretCliAuth
} from './authStatus'
import type { AgentCliSpec } from './spec'
import { captureCli } from './stdioJson'
import { hasKimiProviderCredential } from './kimiCredentialPresence'

const AUTH_TIMEOUT_MS = 3_000

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim()
  return home && isAbsolute(home) ? home : homedir()
}

function xdgData(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.XDG_DATA_HOME?.trim()
  return configured && isAbsolute(configured) ? configured : join(home, '.local', 'share')
}

/** A credential file that is missing or empty (`{}`) does not count as signed in. */
async function nonemptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 2
  } catch {
    return false
  }
}

async function dirHasEntries(path: string): Promise<boolean> {
  try {
    const names = await readdir(path)
    return names.length > 0
  } catch {
    return false
  }
}

function envName(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]
  return typeof value === 'string' && value.trim().length > 0 ? name : null
}

async function credentialPresence(
  id: string,
  env: NodeJS.ProcessEnv,
  cfg: BackendConfig
): Promise<PresenceObservation> {
  const home = homeOf(env)
  let file = false
  const envNames: string[] = []

  switch (id) {
    case 'opencode':
      file = await nonemptyFile(join(xdgData(env, home), 'opencode', 'auth.json'))
      break
    case 'claude': {
      const root = env.CLAUDE_CONFIG_DIR?.trim()
      const dir = root && isAbsolute(root) ? root : join(home, '.claude')
      file = await nonemptyFile(join(dir, '.credentials.json'))
      const api = envName(env, 'ANTHROPIC_API_KEY') ?? envName(env, 'ANTHROPIC_AUTH_TOKEN')
      if (api) envNames.push(api)
      break
    }
    case 'codex': {
      const root = env.CODEX_HOME?.trim()
      const dir = root && isAbsolute(root) ? root : join(home, '.codex')
      file = await nonemptyFile(join(dir, 'auth.json'))
      break
    }
    case 'kimi': {
      const root = env.KIMI_CODE_HOME?.trim()
      const dir = root && isAbsolute(root) ? root : join(home, '.kimi-code')
      file = await dirHasEntries(join(dir, 'credentials'))
      break
    }
    case 'grok': {
      const root = env.GROK_HOME?.trim()
      const dir = root && isAbsolute(root) ? root : join(home, '.grok')
      file = await nonemptyFile(join(dir, 'auth.json'))
      const api = envName(env, 'XAI_API_KEY')
      if (api) envNames.push(api)
      break
    }
    case 'pi': {
      const root = env.PI_CODING_AGENT_DIR?.trim()
      const dir = root && isAbsolute(root) ? root : join(home, '.pi', 'agent')
      file = await nonemptyFile(join(dir, 'auth.json'))
      for (const name of PI_AUTH_ENV) {
        if (envName(env, name)) envNames.push(name)
      }
      break
    }
    case 'droid':
      file =
        (await nonemptyFile(join(home, '.factory', 'auth.v2.file'))) &&
        (await nonemptyFile(join(home, '.factory', 'auth.v2.key')))
      {
        const api = envName(env, 'FACTORY_API_KEY')
        if (api) envNames.push(api)
      }
      break
    default:
      break
  }

  return {
    file,
    envNames,
    rowKey: id === 'grok' && Boolean(cfg.apiKey?.trim() || cfg.hasApiKey)
  }
}

async function runStatus(binaryPath: string, args: readonly string[]): Promise<CommandObservation> {
  try {
    const handle = await spawnLines(binaryPath, {
      args: [...args],
      stdin: 'ignore',
      timeoutMs: AUTH_TIMEOUT_MS
    })
    const out: string[] = []
    const err: string[] = []
    const drain = (async () => {
      for await (const { stream, line } of handle.lines) {
        if (out.length + err.length >= 80) continue
        ;(stream === 'stdout' ? out : err).push(line)
      }
    })().catch(() => undefined)
    const info = await handle.exit
    await drain
    const stdout = out.join('\n')
    const stderr = err.join('\n')
    return {
      ran: !info.error,
      code: info.code,
      stdout,
      stderr,
      timedOut: handle.timedOut(),
      unrecognized: commandUnrecognized(stdout, stderr)
    }
  } catch {
    return { ran: false, code: null, stdout: '', stderr: '', timedOut: false, unrecognized: false }
  }
}

export async function probeCliAuth(
  spec: AgentCliSpec,
  cfg: BackendConfig,
  binaryPath: string | undefined
): Promise<CliAuthInfo> {
  if (!binaryPath) return { state: 'not-installed' }
  const method = authMethod(spec.id)
  const env = await hydratedEnv()
  const presence = await credentialPresence(spec.id, env, cfg)
  if (spec.id === 'kimi' && !presence.file) {
    const root = env.KIMI_CODE_HOME?.trim()
    const dir = root && isAbsolute(root) ? root : join(homeOf(env), '.kimi-code')
    // `provider list` initializes a missing config; a readiness probe must not.
    if (await nonemptyFile(join(dir, 'config.toml'))) {
      const config = await captureCli(binaryPath, ['provider', 'list', '--json'], process.cwd(), AUTH_TIMEOUT_MS)
      if (config.code === 0 && hasKimiProviderCredential(config.stdout)) return { state: 'logged-in', account: 'API key configuration' }
    }
  }
  const command = method?.statusArgs ? await runStatus(binaryPath, method.statusArgs) : null
  return interpretCliAuth(spec.id, command, presence)
}
