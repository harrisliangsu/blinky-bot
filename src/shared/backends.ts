/**
 * Backends: anything that can produce assistant turns.
 *
 * Local and cloud are peers — identical interface, identical tool support.
 * The only difference is where inference runs.
 */

import type { CliAuthInfo } from './cliAuth'
import type { ThinkingDepth } from './thinking'

export type BackendKind = 'local-server' | 'agent-cli' | 'cloud-api'

/**
 * Names the composer can show before a probe finishes.
 * The detected row's label wins once it exists; this only covers the gap.
 */
export const KNOWN_BACKEND_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  grok: 'Grok',
  pi: 'pi',
  droid: 'Droid',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  xai: 'xAI',
  openrouter: 'OpenRouter'
}

export type BackendStatus =
  | 'available'
  | 'not-installed'
  | 'not-running'
  | 'needs-key'
  | 'error'

export interface ModelInfo {
  id: string
  label: string
  size?: number
  contextWindow?: number
  supportsTools?: boolean
  /** Required for computer use. */
  supportsVision?: boolean
  /** Available depths reported by this model's provider; absent means unknown. */
  supportedThinking?: ThinkingDepth[]
  /** Provider-reported default, when available. */
  isDefault?: boolean
}

export interface BackendInfo {
  id: string
  label: string
  kind: BackendKind
  status: BackendStatus
  /** Why it is unavailable, and what the user should do about it. */
  statusDetail?: string
  models: ModelInfo[]
  local: boolean
  /** Native tool-calling, or the prompted fallback protocol. */
  toolMode: 'native' | 'prompted'
  /** The CLI can run model-only on the host while OpenBOT executes tools in a VM. */
  supportsVmOrchestration?: boolean
  /** Present for agent CLIs. Login stays in the CLI; this is only the public state. */
  cliAuth?: CliAuthInfo
}
