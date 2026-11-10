/**
 * OpenCode — headless server transport.
 *
 * `opencode serve --hostname 127.0.0.1 --port 0` prints
 * `opencode server listening on http://127.0.0.1:<port>`; the port is assigned
 * by the OS and read back from that line. The turn is then driven over HTTP,
 * with the server's SSE stream normalised into chunks.
 *
 * Models are whatever the user's own opencode install offers (`opencode models`),
 * so a local model configured inside opencode shows up here as just another slug.
 */

import { errorMessage } from '../httpErrors'
import { inferVision, prettyLabel } from '../modelMeta'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from '../types'
import { detectAgentCli } from './detect'
import {
  createSession,
  interruptSession,
  listServerModels,
  opencodeHeaders,
  replyPermission,
  sendPrompt,
  streamEvents,
  type OpencodeEvent
} from './opencodeApi'
import { opencodeProcessConfig } from './opencodeConfig'
import { acquireServer, releaseServer, runningServer, type ServerRequest } from './serverPool'
import { type AgentCliSpec, type CliRunContext, readCliOptions, resolveBinary, runContext } from './spec'
import { captureCli } from './stdioJson'
import { flattenTranscript } from './transcript'
import { homePath } from '../detectionTable'
import { withTimeout } from '../httpClient'

export const OPENCODE_SPEC: AgentCliSpec = {
  id: 'opencode',
  displayName: 'OpenCode',
  defaultBinaryPath: 'opencode',
  serverReadyPrefix: 'opencode server listening',
  dataDirectoryName: 'opencode',
  serverAuthUsername: 'opencode',
  install: {
    binary: 'opencode',
    versionArgs: ['--version'],
    npmPackage: 'opencode-ai',
    brewFormula: 'opencode',
    curlInstall: 'curl -fsSL https://opencode.ai/install | bash',
    homepage: 'https://opencode.ai',
    paths: () => [homePath('.opencode'), homePath('.config', 'opencode'), homePath('.local', 'share', 'opencode')]
  }
}

/** `provider/model`, splitting on the first slash only. */
function splitSlug(slug: string): { providerID: string; id: string } | null {
  const at = slug.indexOf('/')
  if (at <= 0 || at === slug.length - 1) return null
  return { providerID: slug.slice(0, at), id: slug.slice(at + 1) }
}

function serverRequest(
  spec: AgentCliSpec,
  binaryPath: string,
  ctx: CliRunContext,
  password: string | undefined,
  configContent?: string
): ServerRequest {
  const extraEnv = configContent
    ? {
        OPENCODE_CONFIG_CONTENT: configContent,
        ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {})
      }
    : undefined
  return {
    spec,
    binaryPath,
    cwd: ctx.cwd,
    args: ['serve', '--hostname', '127.0.0.1', '--port', '0', ...ctx.extraArgs],
    ...(extraEnv ? { extraEnv } : {})
  }
}

export function opencodeEventChunks(event: { type: string; data?: Record<string, unknown> }, sessionId: string): ChatChunk[] {
  const data = event.data ?? {}
  if (data.sessionID && data.sessionID !== sessionId) return []

  switch (event.type) {
    case 'session.next.text.delta':
      return typeof data.delta === 'string' && data.delta ? [{ type: 'text', delta: data.delta, visible: true }] : []
    case 'session.next.reasoning.delta':
      return typeof data.delta === 'string' && data.delta ? [{ type: 'reasoning', delta: data.delta }] : []
    case 'session.next.tool.called': {
      const tool = typeof data.tool === 'string' ? data.tool : 'tool'
      const input = data.input && typeof data.input === 'object' ? JSON.stringify(data.input).slice(0, 120) : ''
      return [{ type: 'reasoning', delta: `⏺ ${tool}${input ? `(${input})` : ''}\n`, toolActivity: true }]
    }
    default:
      return []
  }
}

function failureOf(event: { type: string; data?: Record<string, unknown> }): string | null {
  if (event.type !== 'session.next.step.failed' && event.type !== 'session.error') return null
  const error = (event.data ?? {}).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; name?: unknown; data?: { message?: unknown } }
    const message = record.message ?? record.data?.message ?? record.name
    if (typeof message === 'string') return message
  }
  return 'OpenCode reported a failed step.'
}

function permissionRequest(event: OpencodeEvent, sessionId: string): {
  id: string
  action: string
  resources: string[]
  metadata?: Record<string, unknown>
} | null {
  if (event.type !== 'permission.v2.asked' && event.type !== 'permission.asked') return null
  const data = event.data ?? {}
  if (data.sessionID !== sessionId || typeof data.id !== 'string') return null
  const action = typeof data.action === 'string'
    ? data.action
    : typeof data.permission === 'string'
      ? data.permission
      : 'tool'
  const rawResources = Array.isArray(data.resources) ? data.resources : data.patterns
  const resources = Array.isArray(rawResources)
    ? rawResources.filter((entry): entry is string => typeof entry === 'string')
    : []
  const metadata = data.metadata && typeof data.metadata === 'object'
    ? data.metadata as Record<string, unknown>
    : undefined
  return { id: data.id, action, resources, ...(metadata ? { metadata } : {}) }
}

function approvalKind(action: string): 'shell' | 'edit' | 'write' | 'fetch' | 'mcp' {
  const value = action.toLowerCase()
  if (value.includes('bash') || value.includes('shell')) return 'shell'
  if (value.includes('edit')) return 'edit'
  if (value.includes('write') || value.includes('patch')) return 'write'
  if (value.includes('web') || value.includes('fetch') || value.includes('external_directory')) return 'fetch'
  return 'mcp'
}

export function opencodePermissionTarget(
  action: string,
  resources: string[],
  metadata?: Record<string, unknown>
): string {
  const metadataTarget = ['command', 'path', 'filePath', 'url', 'target']
    .map((key) => metadata?.[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return metadataTarget?.trim() || resources.join(', ') || action
}

async function answerPermission(
  req: ChatRequest,
  event: OpencodeEvent,
  baseUrl: string,
  headers: Record<string, string>,
  sessionId: string
): Promise<boolean> {
  const pending = permissionRequest(event, sessionId)
  if (!pending) return false
  // Shell denylisting must inspect the actual command, not a broad permission
  // pattern such as "*". OpenCode includes that exact value in metadata.
  const target = opencodePermissionTarget(pending.action, pending.resources, pending.metadata)
  const detail = [
    `Action: ${pending.action}`,
    pending.resources.length ? `Resources:\n${pending.resources.join('\n')}` : '',
    pending.metadata ? `Metadata:\n${JSON.stringify(pending.metadata, null, 2)}` : ''
  ].filter(Boolean).join('\n\n')
  const decision = req.approve
    ? await req.approve({
        kind: approvalKind(pending.action),
        summary: `OpenCode: ${pending.action}${target ? ` — ${target}` : ''}`,
        detail,
        target,
        force: pending.action.toLowerCase().includes('external_directory')
      })
    : 'reject'
  await replyPermission(
    baseUrl,
    headers,
    sessionId,
    pending.id,
    decision === 'approve-always' ? 'always' : decision === 'approve' ? 'once' : 'reject',
    req.signal
  )
  return true
}

async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(OPENCODE_SPEC, cfg)
  const ctx = runContext(req.model, opts)
  const password = cfg.apiKey?.trim()
  const headers = opencodeHeaders(OPENCODE_SPEC.serverAuthUsername ?? 'opencode', password)
  const processConfig = opencodeProcessConfig(req)

  const server = await acquireServer(serverRequest(OPENCODE_SPEC, binaryPath, ctx, password, processConfig.content))
  try {
    const model = ctx.model === 'default' ? null : splitSlug(ctx.model)
    const sessionId = await createSession(server.baseUrl, headers, model, withTimeout(req.signal, 15_000))

    // Subscribe before prompting so no early delta is missed.
    const events = streamEvents(server.baseUrl, headers, req.signal)
    const prompt = flattenTranscript(req.messages)
    await sendPrompt(server.baseUrl, headers, sessionId, prompt, withTimeout(req.signal, 30_000))

    try {
      for await (const event of events) {
        if (await answerPermission(req, event, server.baseUrl, headers, sessionId)) continue
        const failure = failureOf(event)
        if (failure) throw new Error(failure)
        yield* opencodeEventChunks(event, sessionId)
        if (event.type === 'session.idle' && event.data?.sessionID === sessionId) break
      }
    } finally {
      if (req.signal.aborted) await interruptSession(server.baseUrl, headers, sessionId)
    }
    yield { type: 'done' }
  } finally {
    // Inline config contains this turn's gateway token and permission contract;
    // never keep it alive for a later bot or turn.
    releaseServer(server, { immediate: true })
  }
}

/** `opencode models` prints one `provider/model` slug per line. */
function parseModelSlugs(output: string): ModelInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/[\w./:-]+$/.test(line))
    .map((slug) => ({
      id: slug,
      label: prettyLabel(slug.slice(slug.indexOf('/') + 1)),
      supportsTools: true,
      supportsVision: inferVision(slug)
    }))
}

export const opencodeBackend: Backend = {
  id: OPENCODE_SPEC.id,
  label: OPENCODE_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(OPENCODE_SPEC, cfg),

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    const opts = readCliOptions(cfg)
    const binaryPath = await resolveBinary(OPENCODE_SPEC, cfg)

    // A server may already be up from a previous turn; it knows the most.
    const ctx = runContext('default', opts)
    const password = cfg.apiKey?.trim()
    const existing = await runningServer(serverRequest(OPENCODE_SPEC, binaryPath, ctx, password))
    if (existing) {
      try {
        const headers = opencodeHeaders(OPENCODE_SPEC.serverAuthUsername ?? 'opencode', password)
        const models = await listServerModels(existing.baseUrl, headers, withTimeout(undefined, 5000))
        if (models.length) return models
      } catch {
        // Fall through to the CLI listing.
      }
    }

    const { stdout, output } = await captureCli(binaryPath, ['models'], opts.cwd)
    const models = parseModelSlugs(stdout)
    if (!models.length) {
      throw new Error(`\`opencode models\` returned nothing: ${errorMessage(output.slice(0, 200))}`)
    }
    return models
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
