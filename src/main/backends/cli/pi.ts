/**
 * pi as a backend.
 *
 * `pi --print --mode json` streams `message_update` envelopes, which `piMapper`
 * reads. pi routes to whatever provider its own config names, so a locally
 * served model configured in pi appears here as an ordinary slug.
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
import { piMapper } from './events'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  modelFlag,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { parsePiModels } from './piModels'
import { captureCli, runStdioJson } from './stdioJson'
import { flattenTranscript, systemPromptOf } from './transcript'
import { promptedToolStream, withPromptedTools } from '../promptedTools'

export const PI_SPEC: AgentCliSpec = {
  id: 'pi',
  displayName: 'pi',
  defaultBinaryPath: 'pi',
  dataDirectoryName: 'pi',
  install: {
    binary: 'pi',
    versionArgs: ['--version'],
    npmPackage: '@earendil-works/pi-coding-agent',
    homepage: 'https://github.com/earendil-works/pi',
    paths: () => [homePath('.pi')]
  }
}

function buildArgs(model: string, system: string, extra: string[], readOnly: boolean, thinking?: ChatRequest['thinking']): string[] {
  // --tools overrides --no-tools in pi's SDK; explicit extensions still load
  // with --no-extensions. Neither may bypass the application's approval gate.
  if (extra.some((arg) => /^(--tools|-t|--extension|-e)(=|$)/.test(arg))) {
    throw new Error('pi extra arguments cannot enable native tools or extensions outside application approvals.')
  }
  if (thinking && !['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
    throw new Error('pi does not support the selected thinking depth.')
  }
  const args = [...extra, '--print', '--mode', 'json', '--no-session', '--no-extensions']
  /*
   * A side call has to produce text and nothing else, so it is not given tools
   * at all. Left with the session's own tool set, a background extraction whose
   * only job is to emit a JSON array could edit files unattended.
   */
  if (readOnly) args.push('--no-tools')
  else {
    /*
     * pi's print transport has no permission callback or runtime MCP client.
     * Its native edit/write/bash tools therefore cannot honestly implement
     * OpenBOT's approval policies. Keep the useful native read tool, but fail
     * closed on every mutator rather than letting pi's own config decide.
     */
    args.push('--tools', 'read')
  }
  args.push(...modelFlag('--model', { model, cwd: '', extraArgs: [] }))
  if (thinking) args.push('--thinking', thinking)
  if (system) args.push('--append-system-prompt', system)
  return args
}

async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(PI_SPEC, cfg)
  const ctx = runContext(req.model, opts)
  const modelOnly = req.disableNativeTools === true
  const messages = modelOnly && req.tools?.length
    ? withPromptedTools(req.messages, req.tools)
    : req.messages
  const last = messages[messages.length - 1]
  const trailingTool = modelOnly && last?.role === 'tool' ? last : undefined
  const flattened = flattenTranscript(messages, {
    includeSystem: false,
    includeTrailingTurns: modelOnly
  })
  const prompt = trailingTool
    ? `${flattened}\n\nUser:\nUse the tool result above to finish the original request. ` +
      'If the result is successful, report it plainly now. Do not repeat the same tool call.'
    : flattened

  const stream = runStdioJson({
    onTiming: req.onTiming,
    spec: PI_SPEC,
    binaryPath,
    args: buildArgs(
      ctx.model,
      systemPromptOf(messages),
      ctx.extraArgs,
      req.readOnly === true || modelOnly,
      req.thinking
    ),
    ctx,
    // The system turn travels on --append-system-prompt above; leaving it in
    // the transcript too would send the whole prompt twice.
    prompt,
    promptInput: 'stdin-text',
    mapper: piMapper(),
    signal: req.signal
  })
  if (modelOnly && req.tools?.length) {
    // An empty public stream stays empty. Tool output is not model speech.
    yield* promptedToolStream(stream, req.tools)
  }
  else yield* stream
}

export const piBackend: Backend = {
  id: PI_SPEC.id,
  label: PI_SPEC.displayName,
  kind: 'agent-cli',
  local: true,
  supportsVmOrchestration: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(PI_SPEC, cfg),

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    const opts = readCliOptions(cfg)
    const binaryPath = await resolveBinary(PI_SPEC, cfg)
    try {
      // stdout only: a stderr warning folded into the table parses as a model.
      const { stdout } = await captureCli(binaryPath, ['--list-models'], opts.cwd)
      const models = parsePiModels(stdout)
      // `default` stays first so "let pi decide" survives a listing failure or
      // a table format change.
      return [CLI_DEFAULT_MODEL, ...models]
    } catch {
      return [CLI_DEFAULT_MODEL]
    }
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
