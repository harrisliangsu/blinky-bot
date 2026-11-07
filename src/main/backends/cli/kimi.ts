/**
 * Kimi Code CLI as a backend.
 *
 * `kimi -p --output-format stream-json` is the documented headless mode
 * (`@moonshot-ai/kimi-code`, not the archived Python `kimi-cli`). Print mode
 * already runs with the auto permission policy and rejects `--yolo` / `--auto`
 * next to `-p`, and it has no tool allowlist, so the CLI's own tools are not
 * routed through BlinkyBot's approval card. Background side calls and VM bots
 * are refused in `refuseUngovernedSideCall`.
 */

import { kimiThinkingEnv } from '../../../shared/thinking'
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
import { kimiMapper } from './events'
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
import { parseKimiModels } from './kimiModels'
import { runKimiAcp } from './kimiAcp'
import { imagePartsOf } from '../messageContent'
import { flattenTranscript, latestUserTurn, systemPromptOf } from './transcript'

export const KIMI_SPEC: AgentCliSpec = {
  id: 'kimi',
  displayName: 'Kimi Code',
  defaultBinaryPath: 'kimi',
  dataDirectoryName: 'kimi-code',
  install: {
    binary: 'kimi',
    versionArgs: ['--version'],
    npmPackage: '@moonshot-ai/kimi-code',
    curlInstall: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    homepage: 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html',
    paths: () => [homePath('.kimi-code', 'credentials')]
  }
}

/** Above this, `-p` is likely to hit the OS argument limit. The prompt is one argv. */
const MAX_PROMPT_CHARS = 100_000

export interface KimiArgInput {
  model: string
  prompt: string
  extra: string[]
  sessionId?: string
}

export function buildKimiArgs(input: KimiArgInput): string[] {
  const args = ['--output-format', 'stream-json']
  const session = cliSessionToken(input.sessionId)
  if (session) args.push('--session', session)
  args.push(...modelFlag('--model', { model: input.model, cwd: '', extraArgs: [] }))
  args.push(...input.extra)
  args.push('-p', input.prompt)
  return args
}

function turnPrompt(req: ChatRequest, system: string, resumed: boolean): string {
  const marks = fingerprints(req.messages)
  if (resumed) {
    const fresh = req.messages.slice(firstUnsent(req.sessionKey, marks))
    const body = fresh.length ? flattenTranscript(fresh, { includeSystem: false }) : latestUserTurn(req.messages)
    // Kimi's resumed CLI session does not accept a separate system message.
    // Refresh the current instructions on every turn so memory and user rules
    // changed by another bot are not stranded in the original CLI session.
    return system.trim() ? `${system.trim()}\n\n${body}` : body
  }
  const body = flattenTranscript(req.messages, { includeSystem: false })
  return system.trim() ? `${system.trim()}\n\n${body}` : body
}

async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  refuseUngovernedSideCall(KIMI_SPEC.displayName, req)
  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(KIMI_SPEC, cfg)
  const ctx = runContext(req.model, opts)
  const system = systemPromptOf(req.messages)
  const marks = fingerprints(req.messages)
  let resumeId = rememberedCliSession(KIMI_SPEC.id, req.sessionKey)
  const latestUser = [...req.messages].reverse().find((m) => m.role === 'user')
  const images = latestUser && req.supportsVision !== false ? imagePartsOf(latestUser.content) : []

  // ACP carries both the per-turn MCP gateway and explicit permission
  // requests. A missing gateway must never silently downgrade a governed
  // chat to print mode, which automatically approves native tools.
  if (req.approve || req.mcpServers?.length || images.length) {
    const body = turnPrompt(req, system, Boolean(resumeId)).trim()
    const prompt = body || (images.length ? '[Image attached]' : '')
    if (!prompt) throw new Error('Kimi Code was given an empty prompt.')
    for await (const chunk of runKimiAcp({
      binaryPath, ctx, req, prompt, resumeId, images,
      ...(kimiThinkingEnv(req.thinking) ? { extraEnv: kimiThinkingEnv(req.thinking) } : {}),
      onSession: async (id) => {
        rememberCliSession(KIMI_SPEC.id, req.sessionKey, id)
        if (req.sessionKey) await flushProviderBindings()
      }
    })) {
      if (chunk.type === 'done') {
        rememberSent(req.sessionKey, marks)
        if (req.sessionKey) await flushProviderBindings()
      }
      yield chunk
    }
    return
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = Boolean(resumeId)
    const prompt = turnPrompt(req, system, resumed).trim()
    if (!prompt) throw new Error('Kimi Code was given an empty prompt.')
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error('Kimi Code takes the prompt on the command line, and this turn is too long to pass that way.')
    }

    let captured: string | undefined
    let answered = false
    const thinkingEnv = kimiThinkingEnv(req.thinking)
    try {
      for await (const chunk of runStdioJson({
        spec: KIMI_SPEC,
        binaryPath,
        args: buildKimiArgs({ model: ctx.model, prompt, extra: ctx.extraArgs, sessionId: resumeId }),
        ctx,
        prompt: '',
        promptInput: 'none',
        mapper: kimiMapper((id) => {
          captured = id
        }, req.captureAgentTrace === true),
        signal: req.signal,
        ...(thinkingEnv ? { extraEnv: thinkingEnv } : {})
      })) {
        if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.delta) answered = true
        if (chunk.type !== 'done') yield chunk
      }
      if (captured) rememberCliSession(KIMI_SPEC.id, req.sessionKey, captured)
      rememberSent(req.sessionKey, marks)
      if (req.sessionKey) await flushProviderBindings()
      yield { type: 'done' }
      return
    } catch (err) {
      if (answered || req.signal.aborted || !resumed) throw err
      forgetCliSession(KIMI_SPEC.id, req.sessionKey)
      forgetSent(req.sessionKey)
      resumeId = undefined
    }
  }
}

export const kimiBackend: Backend = {
  id: KIMI_SPEC.id,
  label: KIMI_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(KIMI_SPEC, cfg),

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    try {
      const binaryPath = await resolveBinary(KIMI_SPEC, cfg)
      const opts = readCliOptions(cfg)
      const result = await captureCli(binaryPath, ['provider', 'list', '--json'], opts.cwd, 5000)
      return result.code === 0 ? [CLI_DEFAULT_MODEL, ...parseKimiModels(result.stdout)] : [CLI_DEFAULT_MODEL]
    } catch {
      // Older CLIs may not support this command. The CLI default still works.
      return [CLI_DEFAULT_MODEL]
    }
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
