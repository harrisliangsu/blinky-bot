/**
 * Backends: anything that can produce assistant turns.
 *
 * Local and cloud are peers — identical interface, identical tool support.
 * The only difference is where inference runs.
 */

import type { CliAuthInfo } from './cliAuth'

export type BackendKind = 'local-server' | 'agent-cli' | 'cloud-api'

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
