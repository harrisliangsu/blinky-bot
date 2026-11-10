/**
 * Droid (Factory) as a backend.
 *
 * `droid exec --output-format stream-json` emits Anthropic-shaped events, the
 * same wire shape Claude Code produces, so the mapper is shared. Droid installs
 * to ~/.local/bin, which a Finder-launched app does not have on its PATH — the
 * hydrated login-shell environment is what makes it resolvable.
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
import { detectAgentCli } from './detect'
import { anthropicStyleMapper } from './events'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  modelFlag,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { runStdioJson } from './stdioJson'
import { flattenTranscript, systemPromptOf } from './transcript'

export const DROID_SPEC: AgentCliSpec = {
  id: 'droid',
  displayName: 'Droid',
  defaultBinaryPath: 'droid',
  dataDirectoryName: 'factory',
  install: {
    binary: 'droid',
    versionArgs: ['--version'],
    curlInstall: 'curl -fsSL https://app.factory.ai/cli | sh',
    homepage: 'https://factory.ai',
    // Droid installs outside the default PATH; check its own locations too.
    paths: () => [homePath('.factory'), homePath('.local', 'bin', 'droid')]
  }
}

/**
 * The native tools droid may keep, verified against `droid exec --list-tools`.
 *
 * `droid exec` has no client-side approval callback and no runtime MCP client
 * we can reach, so nothing it does natively can be routed to OpenBOT's gate —
 * it was running with its full tool set, unattended, while `chatRequest.ts`
 * documented its `approve` callback as the only place a droid mutation could be
 * stopped. `--enabled-tools` is droid's own restriction flag and it is an
 * allowlist, so a tool added by a later release is excluded by default rather
 * than silently granted. Every other adapter draws the same line: claude
 * `--tools Read,Glob,…`, pi `--tools read`, opencode `permission: 'deny'`.
 *
 * Note that `--auto` is NOT the flag for this: every level of it is an
 * escalation above droid's default read-only autonomy, never a restriction.
 */
const ENABLED_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'FetchUrl', 'WebSearch']

function buildArgs(model: string, system: string, extra: string[]): string[] {
  const args = ['exec', '--output-format', 'stream-json']
  args.push('--enabled-tools', ENABLED_TOOLS.join(','))
  args.push(...modelFlag('--model', { model, cwd: '', extraArgs: [] }))
  if (system) args.push('--append-system-prompt', system)
  args.push(...extra)
  return args
}

async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  /*
   * Fail CLOSED on a background side call, the way `codex.ts` refuses to fall
   * back to an ungoverned transport.
   *
   * `readOnly` means "produce text and nothing else", and droid has no way to
   * express an empty tool set: `--enabled-tools` restricts the set, it cannot
   * empty it. Post-turn memory extraction sets this flag and passes no
   * `approve` callback, so an unrefused run would be a second agent process
   * with native tools, started after the reply had already streamed, with
   * nobody watching. Refusing is safe here because every caller of a side call
   * treats a failure as "this feature is skipped this turn" — see
   * `runSideCall`, which returns null rather than throwing.
   */
  if (req.readOnly === true) {
    throw new Error(
      'Droid has no tool-free mode, so BlinkyBot refused to run a background side call on it ' +
        'rather than start an unattended agent with native tools.'
    )
  }

  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(DROID_SPEC, cfg)
  const ctx = runContext(req.model, opts)

  yield* runStdioJson({
    onTiming: req.onTiming,
    spec: DROID_SPEC,
    binaryPath,
    args: buildArgs(ctx.model, systemPromptOf(req.messages), ctx.extraArgs),
    ctx,
    // The system turn travels on --append-system-prompt above; leaving it in
    // the transcript too would send the whole prompt twice.
    prompt: flattenTranscript(req.messages, { includeSystem: false }),
    promptInput: 'stdin-text',
    mapper: anthropicStyleMapper(),
    signal: req.signal
  })
}

export const droidBackend: Backend = {
  id: DROID_SPEC.id,
  label: DROID_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(DROID_SPEC, cfg),

  async listModels(): Promise<ModelInfo[]> {
    // Droid's model set is account-driven; `default` uses its configured model.
    return [CLI_DEFAULT_MODEL]
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
