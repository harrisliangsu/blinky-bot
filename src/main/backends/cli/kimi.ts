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
import { fingerprints, firstUnsent, forgetSent, rememberSent } from './resumePrompt'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  modelFlag,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { runStdioJson } from './stdioJson'
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
    return fresh.length ? flattenTranscript(fresh, { includeSystem: false }) : latestUserTurn(req.messages)
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = Boolean(resumeId)
    const prompt = turnPrompt(req, system, resumed).trim()
    if (!prompt) throw new Error('Kimi Code was given an empty prompt.')
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error('Kimi Code takes the prompt on the command line, and this turn is too long to pass that way.')
    }

    let captured: string | undefined
    let answered = false
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
        }),
        signal: req.signal
      })) {
        if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.delta) answered = true
        yield chunk
      }
      if (captured) rememberCliSession(KIMI_SPEC.id, req.sessionKey, captured)
      rememberSent(req.sessionKey, marks)
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

  async listModels(): Promise<ModelInfo[]> {
    return [CLI_DEFAULT_MODEL]
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
