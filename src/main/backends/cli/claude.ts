/**
 * Claude Code as a backend.
 *
 * `claude -p --output-format stream-json` prints one Anthropic-shaped event per
 * line, which is exactly what `anthropicStyleMapper` reads. The CLI owns its own
 * tool loop, auth and model routing; we supply the prompt and read the stream.
 */

import { homePath } from '../detectionTable'
import type {
  Backend,
  BackendConfig,
  ChatChunk,
  ChatRequest,
  DetectResult,
  ModelInfo,
  ProviderImagePart
} from '../types'
import {
  adoptExistingSession,
  confirmClaudeSession,
  continuityArgs,
  forgetSession,
  isSessionIdInUse,
  permissionMode,
  READ_ONLY_PERMISSION_MODE
} from './claudeSession'
import { detectAgentCli } from './detect'
import { anthropicStyleMapper } from './events'
import { claudeMcpConfig } from './mcpConfig'
import { fingerprints, firstUnsent, rememberSent } from './resumePrompt'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  modelFlag,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { runStdioJson } from './stdioJson'
import { claudeStreamInput, turnImages } from './cliImages'
import { flattenTranscript, latestUserTurn, systemPromptOf } from './transcript'
import { flushProviderBindings } from '../../store/providerBindings'

export const CLAUDE_SPEC: AgentCliSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  defaultBinaryPath: 'claude',
  dataDirectoryName: 'claude',
  install: {
    binary: 'claude',
    versionArgs: ['--version'],
    npmPackage: '@anthropic-ai/claude-code',
    brewFormula: 'claude',
    homepage: 'https://claude.com/claude-code',
    paths: () => [homePath('.claude')]
  }
}

/**
 * Claude Code resolves an alias to whatever the current model is, so aliases
 * age better than pinned ids. `default` defers to the CLI's own setting.
 */
const ALIASES: ModelInfo[] = [
  { id: 'opus', label: 'Opus', supportsTools: true, supportsVision: true },
  { id: 'sonnet', label: 'Sonnet', supportsTools: true, supportsVision: true },
  { id: 'haiku', label: 'Haiku', supportsTools: true, supportsVision: true }
]

/**
 * Claude's native mutators cannot call OpenBOT's approval UI in print mode.
 * Offer only native read/search tools and pre-authorise the OpenBOT gateway;
 * write, shell and computer actions then land in our own governed handlers.
 */
export function guardedToolArgs(readOnly: boolean): string[] {
  if (readOnly) return ['--tools', '']
  return [
    '--tools',
    'Read,Glob,Grep,WebFetch,WebSearch',
    '--allowedTools',
    'mcp__openbot__*'
  ]
}

export function buildArgs(
  req: ChatRequest,
  model: string,
  system: string,
  extra: string[],
  continuity: string[],
  mcpArgs: string[]
): string[] {
  if (req.executionAccess === 'full-access') {
    if (req.readOnly || req.restrictNativeWrites || req.coordinatorOnly || req.disableNativeTools) throw new Error('This role cannot use independent full access.')
    if (extra.some(arg => /^(--permission-mode|--tools|--allowedTools|--disallowedTools|--dangerously-skip-permissions|--allow-dangerously-skip-permissions)(=|$)/.test(arg))) throw new Error('Claude extra arguments cannot override the explicit execution profile.')
  }
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    // stream-json in print mode requires --verbose; without it the CLI errors.
    '--verbose'
  ]
  /*
   * `--mcp-config` is variadic, so its value must be followed by another flag
   * rather than by a bare word — hence its place in the middle of the list.
   */
  args.push(...mcpArgs)
  /*
   * Claude Code governs its own tools, so OpenBOT's approval policy has to be
   * translated into its permission mode. Omitting this let the CLI fall back to
   * its own default, which could be more permissive than the user asked for.
   */
  args.push(
    '--permission-mode',
    req.readOnly ? READ_ONLY_PERMISSION_MODE : req.executionAccess === 'full-access' ? 'bypassPermissions' : permissionMode(req.approvalPolicy)
  )
  args.push(...(req.executionAccess === 'full-access' && !req.readOnly ? ['--tools', 'default', '--disallowedTools', 'AskUserQuestion'] : guardedToolArgs(req.readOnly === true)))
  args.push(...continuity)
  args.push(...modelFlag('--model', { model, cwd: '', extraArgs: [] }))
  if (system) args.push('--append-system-prompt', system)
  args.push(...extra)
  return args
}

/**
 * Recoveries available for a broken conversation, and therefore the most
 * attempts one turn can make: adopt the conversation Claude already holds, and
 * — if resuming that fails too — mint a fresh one. Anything beyond those two is
 * looping, not recovering.
 */
const MAX_CONTINUITY_RETRIES = 2

/**
 * Claude Code persists the conversation itself, so continuity is a session id
 * rather than a held-open process. Two failures have a recovery rather than a
 * dead thread: an id Claude already holds (the app restarted, and the derived
 * id names a live conversation) becomes a `--resume` of that conversation, and
 * a resume that fails — Claude pruned it, or the id is unknown — starts a clean
 * session instead of leaving the user stuck.
 */
async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(CLAUDE_SPEC, cfg)
  const ctx = runContext(req.model, opts)
  const system = systemPromptOf(req.messages)
  const mcp = claudeMcpConfig(req.mcpServers)

  /*
   * On `--resume` Claude already holds the conversation, so re-sending the
   * transcript hands it the same history twice. A resumed turn sends only what
   * the conversation has not seen — which is NOT the same as the newest user
   * message: on a multi-bot turn that is the moderator's brief alone, and the
   * teammate's reply and the user's own question never reached the model.
   *
   * Image bytes are not in that text. When this slice has any, stdin becomes
   * one stream-json user message and `--input-format stream-json` tells Claude
   * Code to forward the blocks. A turn with no image stays on the text stdin
   * this path has always used.
   */
  const marks = fingerprints(req.messages)
  const promptFor = (resuming: boolean): { text: string; images: ProviderImagePart[] } => {
    // `system` is passed with --append-system-prompt, so it must not also ride
    // along inside the transcript. `inline` because any images go out as blocks.
    const opts = { includeSystem: false as const, images: 'inline' as const }
    const full = flattenTranscript(req.messages, opts)
    if (!resuming) return { text: full, images: turnImages(req.messages, false) }
    const fresh = req.messages.slice(firstUnsent(req.sessionKey, marks))
    const partial = fresh.length ? flattenTranscript(fresh, opts) : latestUserTurn(req.messages)
    if (partial) {
      return {
        text: partial,
        images: turnImages(fresh.length ? fresh : req.messages, fresh.length === 0)
      }
    }
    return { text: full, images: turnImages(req.messages, false) }
  }

  const run = (continuity: string[]): AsyncGenerator<ChatChunk> => {
    const { text, images } = promptFor(continuity[0] === '--resume')
    const visual = claudeStreamInput(text, images)
    const args = buildArgs(req, ctx.model, system, ctx.extraArgs, continuity, mcp.args)
    if (visual) args.push('--input-format', 'stream-json')
    return runStdioJson({
      onTiming: req.onTiming,
      spec: CLAUDE_SPEC,
      binaryPath,
      args,
      ctx,
      prompt: visual ?? text,
      promptInput: 'stdin-text',
      mapper: anthropicStyleMapper(),
      signal: req.signal,
      ...(Object.keys(mcp.env).length > 0 ? { extraEnv: mcp.env } : {})
    })
  }

  let continuity = continuityArgs(req.sessionKey)
  /*
   * Only visible output counts as "the turn is genuinely underway". Treating
   * any chunk as output meant a resume that emitted a single init or usage
   * event before failing skipped the retry, and the user was left on a thread
   * that could never be resumed again. It never resets between attempts: once
   * the user has seen part of an answer, retrying would show it twice.
   */
  let answered = false
  for (let attempt = 0; ; attempt++) {
    const resuming = continuity[0] === '--resume'
    try {
      for await (const chunk of run(continuity)) {
        if ((chunk.type === 'text' || chunk.type === 'reasoning') && chunk.delta) answered = true
        if (chunk.type !== 'done') yield chunk
      }
      break
    } catch (err) {
      if (answered || req.signal.aborted || req.executionAccess === 'full-access' || attempt >= MAX_CONTINUITY_RETRIES) throw err
      if (!resuming && isSessionIdInUse(err)) {
        // Claude Code kept the conversation across the restart; join it rather
        // than failing the first turn of every existing chat.
        if (!adoptExistingSession(req.sessionKey)) throw err
      } else if (resuming) {
        forgetSession(req.sessionKey)
      } else {
        throw err
      }
      continuity = continuityArgs(req.sessionKey)
    }
  }
  confirmClaudeSession(req.sessionKey)
  rememberSent(req.sessionKey, marks)
  if (req.sessionKey) await flushProviderBindings()
  yield { type: 'done' }
}

export const claudeBackend: Backend = {
  id: CLAUDE_SPEC.id,
  label: CLAUDE_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(CLAUDE_SPEC, cfg),

  async listModels(): Promise<ModelInfo[]> {
    // Claude Code has no model-listing command; aliases are its documented surface.
    return [CLI_DEFAULT_MODEL, ...ALIASES]
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
