/**
 * Codex as a backend.
 *
 * The persistent app-server runs one turn and routes every native approval back
 * to OpenBOT. A one-shot `codex exec` fallback is deliberately not used: it
 * cannot preserve that approval boundary.
 */

import { codexEffort } from '../../../shared/thinking'
import { homePath } from '../detectionTable'
import type {
  Backend,
  BackendConfig,
  ChatChunk,
  ChatRequest,
  DetectResult,
  ModelInfo
} from '../types'
import { runCodexAppServer } from './codexAppServer'
import { presentCodexError } from './codexEvents'
import { listCodexModels } from './codexModels'
import { detectAgentCli } from './detect'
import { codexMcpConfig } from './mcpConfig'
import {
  type AgentCliSpec,
  CLI_DEFAULT_MODEL,
  commandFor,
  readCliOptions,
  resolveBinary,
  runContext
} from './spec'
import { which } from '../which'

export const CODEX_SPEC: AgentCliSpec = {
  id: 'codex',
  displayName: 'Codex',
  defaultBinaryPath: 'codex',
  dataDirectoryName: 'codex',
  install: {
    binary: 'codex',
    versionArgs: ['--version'],
    npmPackage: '@openai/codex',
    brewFormula: 'codex',
    homepage: 'https://developers.openai.com/codex/cli',
    paths: () => [homePath('.codex')]
  }
}

/**
 * The persistent app-server keeps a thread alive and routes permission prompts
 * to OpenBOT's approval gate. If it cannot start, fail closed: silently falling
 * back to one-shot `exec` would hand approval decisions back to the CLI.
 */
async function* runTurn(req: ChatRequest, cfg: BackendConfig): AsyncGenerator<ChatChunk> {
  const opts = readCliOptions(cfg, req.cwd)
  const binaryPath = await resolveBinary(CODEX_SPEC, cfg)
  const ctx = runContext(req.model, opts, codexEffort(req.thinking))
  // Codex takes `-c` on both transports, so the same servers reach either path.
  const mcp = codexMcpConfig(req.mcpServers)

  try {
    // The prompt is chosen inside the app-server: the full transcript on a cold
    // thread, only the new user text when that thread is still warm.
    yield* runCodexAppServer({ binaryPath, ctx, req, mcp })
  } catch (err) {
    if (req.signal.aborted) throw err
    throw presentCodexError(err)
  }
}

export const codexBackend: Backend = {
  id: CODEX_SPEC.id,
  label: CODEX_SPEC.displayName,
  kind: 'agent-cli',
  local: true,

  detect: (cfg: BackendConfig): Promise<DetectResult> => detectAgentCli(CODEX_SPEC, cfg),

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    // `default` still means "whatever Codex itself is set to".
    const binary = await which(commandFor(CODEX_SPEC, cfg))
    if (!binary) return [CLI_DEFAULT_MODEL]
    try {
      const found = await listCodexModels(binary, readCliOptions(cfg).cwd)
      return found.length ? [CLI_DEFAULT_MODEL, ...found] : [CLI_DEFAULT_MODEL]
    } catch {
      // A probe that never answers must not empty the picker.
      return [CLI_DEFAULT_MODEL]
    }
  },

  chat: (req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> => runTurn(req, cfg)
}
