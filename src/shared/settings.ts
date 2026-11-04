/** User settings. Everything is stored locally; nothing is uploaded. */

import type { AgentMode } from './sessions'

export type ApprovalPolicy =
  | 'ask-every-time'
  | 'ask-first-time'
  | 'allowlist'
  | 'auto-run'

export interface BackendConfig {
  enabled: boolean
  baseUrl?: string
  /** Stored locally; sent only to that backend's own endpoint. */
  apiKey?: string
  /** Renderer-safe indication that an API key exists in the OS credential store. */
  hasApiKey?: boolean
  /** Write-only renderer instruction; never persisted. */
  clearApiKey?: boolean
  /** Explicit executable path when auto-detection fails. */
  command?: string
  extraArgs?: string[]
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  /** Optional catalogue identity and account label. */
  provider?: string
  accountName?: string
  /** Remote MCP authentication. OAuth is completed by the supporting agent CLI. */
  auth?: 'none' | 'bearer' | 'oauth'
  /** Write-only. Stored encrypted by the main process and never returned to the renderer. */
  bearerToken?: string
  hasBearerToken?: boolean
  clearBearerToken?: boolean
  /** User-disabled MCP tool names, retained for clients that support tool filtering. */
  disabledTools?: string[]
}

export type UiLanguage = 'system' | 'en' | 'zh-CN'
export type SendShortcut = 'enter' | 'mod-enter'
export type LinkOpen = 'browser' | 'window'
export type AccentColor = 'theme' | 'amber' | 'blue' | 'purple' | 'pink' | 'green' | 'slate' | 'orange' | 'red'
export type UpdateChannel = 'stable' | 'beta'
export type UiScale = 80 | 90 | 100 | 110 | 125 | 150

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  fontSize: number
  /** Whole-interface percentage. 100 keeps the current size. */
  uiScale: UiScale
  /** Window translucency. On macOS this is also native vibrancy. */
  vibrant: boolean
  language: UiLanguage
  accent: AccentColor
  sendShortcut: SendShortcut
  /** Tool rows start expanded. */
  expandSteps: boolean
  linkOpen: LinkOpen
  /** Start the packaged app when the user logs in. Separate from background running. */
  launchAtLogin: boolean
  profileName: string
  profileEmoji: string
  profileColor: string
  /** Desktop notifications for approvals, help, and failures. */
  notifications: boolean
  /** Also notify when a turn finishes while the window is in the background. */
  notifyOnTurn: boolean
  updateChannel: UpdateChannel
  defaultBackendId: string
  defaultModelId: string
  defaultMode: AgentMode
  approvalPolicy: ApprovalPolicy
  /** Shell commands auto-approved without prompting. */
  allowlist: string[]
  /** Shell commands always refused. */
  denylist: string[]
  /** Global custom instructions, prepended for every bot. */
  rules: string
  backends: Record<string, BackendConfig>
  mcpServers: McpServerConfig[]
  /**
   * Whether a finished turn is followed by a second model call that extracts
   * durable facts into the bot's memory.
   *
   * `api` — the default — allows it only on direct model APIs, where it is one
   * cheap JSON completion. On an agent CLI the same "short side call" spawns a
   * whole second agent process for every turn, billable and running its own
   * tool loop, which is not something to do behind the user's back. `all` opts
   * into that; `off` turns extraction off everywhere.
   */
  memoryExtraction?: 'off' | 'api' | 'all'
  /** Keep the coordinator and routine scheduler alive with no window, and start it at login. */
  runInBackground?: boolean
  /** Apps the user has granted computer-use access to. */
  computerUseAllowedApps: string[]
  /** OpenBOT never phones home. Kept so the UI can state it plainly. */
  telemetry: false
}
