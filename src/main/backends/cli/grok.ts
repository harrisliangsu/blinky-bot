/**
 * The official xAI Grok CLI as a backend (`grok` from `@xai-official/grok`).
 *
 * Chat uses ACP when an application permission handler or MCP servers are
 * available. The legacy print transport is retained for simple callers that
 * do not provide those capabilities. `--no-auto-update` keeps a daily-updated binary from stalling the
 * turn on its updater. Sign-in is `grok login` (`~/.grok/auth.json`); an API
 * key saved on this row is passed as `XAI_API_KEY`, which the CLI accepts when
 * no session is active. The direct `xai` cloud backend is a separate adapter.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { homePath } from '../detectionTable'
import type {
  Backend,
  BackendConfig,
  ChatChunk,
  ChatRequest,
  DetectResult,
  ModelInfo
} from '../types'
import { cliSessionToken, forgetCliSession, rememberCliSession, rememberedCliSession } from './cliSession'
import { detectAgentCli } from './detect'
import { grokMapper } from './events'
import { refuseUngovernedSideCall } from './printMode'
import { flushProviderBindings } from '../../store/providerBindings'
import { fingerprints, firstUnsent, forgetSent, rememberSent } from './resumePrompt'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  modelFlag,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { captureCli, runStdioJson } from './stdioJson'
import { flattenTranscript, latestUserTurn, systemPromptOf } from './transcript'
import { imagePartsOf } from '../messageContent'
import { runGrokAcp } from './kimiAcp'

export const GROK_SPEC: AgentCliSpec = {
  id: 'grok',
  displayName: 'Grok',
  defaultBinaryPath: 'grok',
  dataDirectoryName: 'grok',
  install: {
    binary: 'grok',
    versionArgs: ['version'],
    npmPackage: '@xai-official/grok',
    curlInstall: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    homepage: 'https://docs.x.ai/build/cli/headless-scripting',
    paths: () => [homePath('.grok', 'auth.json')]
  }
}

/** Parse only model rows printed by `grok models`, never arbitrary diagnostic text. */
export function parseGrokModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  let inModels = false
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Available models:\s*$/i.test(line)) {
      inModels = true
      continue
    }
    if (!inModels) continue
    const match = /^\s*[*-]\s+([A-Za-z0-9._:@/-]{1,120})(?:\s+\(default\))?\s*$/i.exec(line)
    if (!match) continue
    const id = match[1]!
    if (id === 'default' || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id })
  }
  return models
}

export interface GrokArgInput {
  model: string
  promptFile: string
  cwd: string
  system: string
  extra: string[]
  sessionId?: string
}

export function buildGrokArgs(input: GrokArgInput): string[] {
  const args = [
    '--no-auto-update',
    '--always-approve',
    '--output-format',
    'streaming-json',
    '--cwd',
    input.cwd,
    '--prompt-file',
    input.promptFile
  ]
  args.push(...modelFlag('--model', { model: input.model, cwd: input.cwd, extraArgs: [] }))
  if (input.system.trim()) args.push('--rules', input.system)
  const session = cliSessionToken(input.sessionId)
  if (session) args.push('--resume', session)
  args.push(...input.extra)
  return args
}

function turnPrompt(req: ChatRequest, resumed: boolean): string {
  if (resumed) {
    const fresh = req.messages.slice(firstUnsent(req.sessionKey, fingerprints(req.messages)))
    return fresh.length ? flattenTranscript(fresh, { includeSystem: false }) : latestUserTurn(req.messages)
  }
  return flattenTranscript(req.messages, { includeSystem: false })
}

async function* runOnce(
  req: ChatRequest,
  cfg: BackendConfig,
  binaryPath: string,
  prompt: string,
  sessionId: string | undefined
): AsyncGenerator<ChatChunk> {
  const opts = readCliOptions(cfg, req.cwd)
  const ctx = runContext(req.model, opts)
  const dir = await mkdtemp(join(tmpdir(), 'blinkybot-grok-'))
  const promptFile = join(dir, 'prompt.txt')
  let captured: string | undefined
  const apiKey = cfg.apiKey?.trim()
  try {
    await writeFile(promptFile, prompt, { mode: 0o600 })
    for await (const chunk of runStdioJson({
      spec: GROK_SPEC,
      binaryPath,
      args: buildGrokArgs({
        model: ctx.model,
        promptFile,
        cwd: ctx.cwd,
        system: sessionId ? '' : systemPromptOf(req.messages),
        extra: ctx.extraArgs,
        sessionId
      }),
      ctx,
      prompt: '',
      promptInput: 'none',
      mapper: grokMapper((id) => {
        captured = id
      }, req.captureAgentTrace === true),
      signal: req.signal,
      ...(apiKey ? { extraEnv: { XAI_API_KEY: apiKey } } : {})
    })) {
      if (chunk.type !== 'done') yield chunk
    }
    if (captured) rememberCliSession(GROK_SPEC.id, req.sessionKey, captured)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  refuseUngovernedSideCall(GROK_SPEC.displayName, req)
  const binaryPath = await resolveBinary(GROK_SPEC, cfg)
  const marks = fingerprints(req.messages)
  let resumeId = rememberedCliSession(GROK_SPEC.id, req.sessionKey)

  const latestUser = [...req.messages].reverse().find((message) => message.role === 'user')
  const images = latestUser && req.supportsVision !== false ? imagePartsOf(latestUser.content) : []
  if (req.executionAccess === 'full-access' || req.approve || req.mcpServers?.length || images.length) {
    const opts = readCliOptions(cfg, req.cwd), ctx = runContext(req.model, opts)
    const body = turnPrompt(req, Boolean(resumeId)).trim(), system = systemPromptOf(req.messages).trim()
    const prompt = [system, body || (images.length ? '[Image attached]' : '')].filter(Boolean).join('\n\n')
    if (!prompt) throw new Error('Grok was given an empty prompt.')
    const apiKey = cfg.apiKey?.trim()
    for await (const chunk of runGrokAcp({
      binaryPath, ctx, req, prompt, resumeId, images,
      ...(apiKey ? { extraEnv: { XAI_API_KEY: apiKey } } : {}),
      onSession: async (id) => { rememberCliSession(GROK_SPEC.id, req.sessionKey, id); if (req.sessionKey) await flushProviderBindings() }
    })) {
      if (chunk.type === 'done') { rememberSent(req.sessionKey, marks); if (req.sessionKey) await flushProviderBindings() }
      yield chunk
    }
    return
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = Boolean(resumeId)
    const prompt = turnPrompt(req, resumed).trim()
    if (!prompt) throw new Error('Grok was given an empty prompt.')
    let answered = false
    try {
      for await (const chunk of runOnce(req, cfg, binaryPath, prompt, resumeId)) {
        if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.delta) answered = true
        yield chunk
      }
      rememberSent(req.sessionKey, marks)
      if (req.sessionKey) await flushProviderBindings()
      yield { type: 'done' }
      return
    } catch (err) {
      if (answered || req.signal.aborted || !resumed) throw err
      forgetCliSession(GROK_SPEC.id, req.sessionKey)
      forgetSent(req.sessionKey)
      resumeId = undefined
    }
  }
}

export const grokBackend: Backend = {
  id: GROK_SPEC.id,
  label: GROK_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(GROK_SPEC, cfg),

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    try {
      const binaryPath = await resolveBinary(GROK_SPEC, cfg)
      const opts = readCliOptions(cfg)
      const result = await captureCli(binaryPath, ['models'], opts.cwd, 5000)
      return result.code === 0 ? [CLI_DEFAULT_MODEL, ...parseGrokModels(result.stdout)] : [CLI_DEFAULT_MODEL]
    } catch {
      return [CLI_DEFAULT_MODEL]
    }
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
