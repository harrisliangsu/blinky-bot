/**
 * How each agent CLI reports sign-in, and how that report is read.
 *
 * Parsers keep only a public label. Tokens, key files, and command output
 * that looks like a secret are never returned and never written down.
 *
 * Sources, from each CLI's public docs:
 * - OpenCode: `opencode auth list` (credentials file `~/.local/share/opencode/auth.json`)
 * - Claude Code: `claude auth status` (exit 0 signed in, 1 not; macOS keychain,
 *   file fallback `~/.claude/.credentials.json`)
 * - Codex: `codex login status` (exit 0 signed in; "Logged in using ChatGPT")
 * - Kimi Code: no status command; `~/.kimi-code/credentials/` from `kimi login`
 * - Grok: no status command; `~/.grok/auth.json` from `grok login`, else `XAI_API_KEY`
 * - pi: no sign-in status command; `~/.pi/agent/auth.json` or a provider env var.
 *   Sign-in is `/login` in the pi session.
 * - Droid: `droid doctor --json --auth` when the binary provides it; otherwise
 *   `~/.factory/auth.v2.file` with `auth.v2.key`, or `FACTORY_API_KEY`.
 *   Sign-in is `/login` in the droid session.
 */

import { dirname } from 'node:path'
import type { CliAuthInfo } from '../../../shared/cliAuth'

export interface CliAuthMethod {
  id: string
  /** Official sign-in argv. Empty launches the CLI so `/login` is available. */
  loginArgs: readonly string[]
  /** Documented status argv. Omitted when the CLI has no status command. */
  statusArgs?: readonly string[]
  /** Sign-in is a slash command inside the interactive CLI. */
  slashLogin?: boolean
}

export const CLI_AUTH_METHODS: readonly CliAuthMethod[] = [
  { id: 'opencode', loginArgs: ['auth', 'login'], statusArgs: ['auth', 'list'] },
  { id: 'claude', loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status'] },
  { id: 'codex', loginArgs: ['login'], statusArgs: ['login', 'status'] },
  { id: 'kimi', loginArgs: ['login'] },
  { id: 'grok', loginArgs: ['login'] },
  { id: 'pi', loginArgs: [], slashLogin: true },
  { id: 'droid', loginArgs: [], statusArgs: ['doctor', '--json', '--auth'], slashLogin: true }
]

export function authMethod(id: string): CliAuthMethod | undefined {
  return CLI_AUTH_METHODS.find((method) => method.id === id)
}

/** Provider env vars pi documents as a way to sign in without `auth.json`. */
export const PI_AUTH_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY'
] as const

const SECRETISH = /sk-|xai-|fk-|gh[pousr]_|AIza|eyJ|bearer|access[_-]?token|refresh[_-]?token|secret|password|api[_-]?key\s*[:=]/i

/** A label safe to put on a settings pill. Anything secret-shaped is dropped. */
export function publicAccountLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 80) return undefined
  if (SECRETISH.test(text)) return undefined
  if (/[A-Za-z0-9+/_=-]{32,}/.test(text)) return undefined
  return text
}

export function commandUnrecognized(stdout: string, stderr: string): boolean {
  return /unknown (?:command|subcommand|option)|unrecognized|unexpected argument|no such command|not a (?:valid|recognized) command|invalid (?:subcommand|choice|command)/i.test(
    `${stdout}\n${stderr}`
  )
}

export interface CommandObservation {
  ran: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  unrecognized: boolean
}

export interface PresenceObservation {
  /** Documented credential file or directory exists and is non-empty. */
  file: boolean
  /** Names of documented env vars that are set. Never the values. */
  envNames: string[]
  /** The settings row already has a key this CLI accepts (Grok). */
  rowKey: boolean
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function combined(stdout: string, stderr: string): string {
  return stripAnsi(`${stdout}\n${stderr}`).trim()
}

function firstJson(text: string): unknown {
  const start = text.search(/[{[]/)
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

function accountOf(label: string | undefined): { account?: string } {
  const account = publicAccountLabel(label)
  return account ? { account } : {}
}

export function parseCodexLoginStatus(code: number | null, stdout: string, stderr: string): CliAuthInfo {
  const text = combined(stdout, stderr)
  if (/not logged in/i.test(text)) return { state: 'logged-out' }
  if (/logged in using chatgpt/i.test(text)) return { state: 'logged-in', ...accountOf('ChatGPT') }
  if (/logged in using (?:an )?api key/i.test(text)) return { state: 'logged-in', ...accountOf('API key') }
  if (/logged in/i.test(text) || code === 0) return { state: 'logged-in' }
  // Non-zero with no other message is the documented "not signed in" exit.
  if (code !== 0 && code !== null && text.length === 0) return { state: 'logged-out' }
  return { state: 'unknown' }
}

const CLAUDE_METHOD: Record<string, string> = {
  'claude.ai': 'claude.ai',
  oauth_token: 'OAuth',
  api_key: 'API key',
  api_key_helper: 'API key helper',
  third_party: 'third-party'
}

export function parseClaudeAuthStatus(code: number | null, stdout: string, stderr: string): CliAuthInfo {
  const text = combined(stdout, stderr)
  const parsed = firstJson(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const method = typeof record.authMethod === 'string' ? record.authMethod : ''
    const email = typeof record.email === 'string' ? publicAccountLabel(record.email) : undefined
    if (record.loggedIn === false || method === 'none') return { state: 'logged-out' }
    if (record.loggedIn === true || (method && method !== 'none') || code === 0) {
      return { state: 'logged-in', ...accountOf(email ?? CLAUDE_METHOD[method]) }
    }
  }
  if (/not logged in|logged out|sign-in state:\s*false/i.test(text)) return { state: 'logged-out' }
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (/logged in|signed in|authenticated/i.test(text)) {
    return { state: 'logged-in', ...accountOf(email?.[0]) }
  }
  // Documented: exit 0 is signed in, exit 1 is not.
  if (code === 0) return { state: 'logged-in' }
  if (code === 1) return { state: 'logged-out' }
  return { state: 'unknown' }
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/

function providerId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!PROVIDER_ID.test(id) || SECRETISH.test(id)) return null
  if (/^(none|null|undefined|true|false)$/i.test(id)) return null
  return id
}

function providerNames(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) providerNames(entry, into)
    return
  }
  if (!value || typeof value !== 'object') {
    const id = providerId(value)
    if (id) into.add(id)
    return
  }
  const record = value as Record<string, unknown>
  const named = providerId(record.provider) ?? providerId(record.providerID) ?? providerId(record.id) ?? providerId(record.name)
  if (named) into.add(named)
  const looksLikeMap = !named && Object.keys(record).every((key) => providerId(key))
  if (looksLikeMap) {
    for (const key of Object.keys(record)) {
      const id = providerId(key)
      if (id) into.add(id)
    }
    return
  }
  for (const nested of ['accounts', 'providers', 'credentials', 'results']) {
    if (nested in record) providerNames(record[nested], into)
  }
}

export function parseOpencodeAuthList(code: number | null, stdout: string, stderr: string): CliAuthInfo {
  const text = combined(stdout, stderr)
  const names = new Set<string>()
  const parsed = firstJson(stdout) ?? firstJson(text)
  if (parsed !== undefined) providerNames(parsed, names)
  if (!names.size) {
    for (const line of stdout.split('\n')) {
      const id = providerId(stripAnsi(line).replace(/^[-*]\s*/, '').trim())
      if (id) names.add(id)
    }
  }
  if (names.size) {
    const account = [...names].slice(0, 3).join(', ')
    return { state: 'logged-in', ...accountOf(account) }
  }
  if (/no (?:credentials|providers|accounts)|not logged in|not authenticated/i.test(text)) {
    return { state: 'logged-out' }
  }
  if (code === 0) return { state: 'logged-out' }
  return { state: 'unknown' }
}

export function parseDroidDoctor(code: number | null, stdout: string, stderr: string): CliAuthInfo {
  const text = combined(stdout, stderr)
  const parsed = firstJson(stdout) ?? firstJson(text)
  if (parsed && typeof parsed === 'object') {
    const record = parsed as { ok?: unknown; results?: unknown }
    const results = Array.isArray(record.results) ? record.results : []
    const auth = results.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const row = entry as { id?: unknown; category?: unknown }
      return /auth/i.test(`${row.id ?? ''} ${row.category ?? ''}`)
    })
    const rows = (auth.length ? auth : results).filter((entry) => entry && typeof entry === 'object') as Array<{
      status?: unknown
      detail?: unknown
    }>
    const pass = rows.some((row) => row.status === 'pass')
    const fail = rows.some((row) => row.status === 'fail')
    if (pass) {
      const detail = rows.find((row) => row.status === 'pass')?.detail
      const account = typeof detail === 'string' && /FACTORY_API_KEY/.test(detail) ? 'FACTORY_API_KEY' : undefined
      return { state: 'logged-in', ...accountOf(account) }
    }
    if (fail || record.ok === false) return { state: 'logged-out' }
  }
  if (/authenticated|auth[^\n]{0,40}\bpass\b/i.test(text)) return { state: 'logged-in' }
  if (/not authenticated|no credentials|auth[^\n]{0,40}\bfail\b/i.test(text)) return { state: 'logged-out' }
  if (code === 0 || code === 1) return { state: 'unknown' }
  return { state: 'unknown' }
}

function parseCommand(id: string, command: CommandObservation): CliAuthInfo | null {
  if (!command.ran || command.timedOut || command.unrecognized) return null
  switch (id) {
    case 'codex':
      return parseCodexLoginStatus(command.code, command.stdout, command.stderr)
    case 'claude':
      return parseClaudeAuthStatus(command.code, command.stdout, command.stderr)
    case 'opencode':
      return parseOpencodeAuthList(command.code, command.stdout, command.stderr)
    case 'droid':
      return parseDroidDoctor(command.code, command.stdout, command.stderr)
    default:
      return null
  }
}

function fromPresence(id: string, presence: PresenceObservation): CliAuthInfo | null {
  if (presence.file) return { state: 'logged-in' }
  if (presence.envNames.length) {
    return { state: 'logged-in', ...accountOf(presence.envNames.slice(0, 3).join(', ')) }
  }
  if (presence.rowKey && id === 'grok') return { state: 'logged-in', ...accountOf('API key') }
  return null
}

/**
 * Prefer the CLI's own status command. A missing command, or one this version
 * does not have, falls back to credential presence. A timeout with nothing on
 * disk stays unknown rather than a guessed sign-out.
 */
export function interpretCliAuth(
  id: string,
  command: CommandObservation | null,
  presence: PresenceObservation
): CliAuthInfo {
  const parsed = command ? parseCommand(id, command) : null
  if (parsed && parsed.state !== 'unknown') return parsed
  const stored = fromPresence(id, presence)
  if (stored) return stored
  if (command?.timedOut) return { state: 'unknown' }
  if (command?.ran && !command.unrecognized && parsed?.state === 'unknown') return { state: 'unknown' }
  return { state: 'logged-out' }
}

/** Quote one shell word. The login binary is user-configurable, so it is never spliced raw. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * One shell line Terminal.app can run. The sentinel receives the exit code
 * only, so BlinkyBot can refresh after the CLI's own login process ends.
 */
export function loginTerminalCommand(binary: string, args: readonly string[], sentinelPath: string): string {
  const run = [shQuote(binary), ...args.map((arg) => shQuote(arg))].join(' ')
  const file = shQuote(sentinelPath)
  const dir = shQuote(dirname(sentinelPath))
  return `${run}; status=$?; mkdir -p ${dir}; printf '%s\\n' "$status" > ${file}; exit "$status"`
}
