/** User settings. Everything is stored locally; nothing is uploaded. */

import type { AppLinks } from './apps'
import type { AgentMode } from './sessions'
import type { ThinkingDepth } from './thinking'
import type { LocalExecutionPolicy } from './localExecution'
import type { SemanticPermissionRule } from './permissionRules'

export type ApprovalPolicy =
  | 'ask-every-time'
  | 'ask-first-time'
  | 'allowlist'
  | 'auto-run'

export interface BackendConfig {
  enabled: boolean
  /**
   * Cloud providers stay out of Settings until the user adds one.
   * A CLI is listed when it is installed and signed in. `added` also lists
   * one the user picked before it is usable. BlinkyBot still does not store
   * the CLI's own login token.
   */
  added?: boolean
  baseUrl?: string
  /** User-created API endpoint and its wire protocol. */
  providerName?: string
  providerProtocol?: 'openai' | 'anthropic'
  /** Origin explicitly associated with the saved credential by the main process. */
  credentialOrigin?: string
  /** Stored locally; sent only to that backend's own endpoint. */
  apiKey?: string
  /** Renderer-safe indication that an API key exists in the OS credential store. */
  hasApiKey?: boolean
  /** Write-only renderer instruction; never persisted. */
  clearApiKey?: boolean
  /** Explicit executable path when auto-detection fails. */
  command?: string
  extraArgs?: string[]
  /** Model this CLI or provider uses when a Bot is bound to it. */
  defaultModelId?: string
  /** Preferred thinking depth per model; an omitted entry follows the backend default. */
  modelThinking?: Record<string, ThinkingDepth>
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
  /** Native AppKit glass on supported macOS; unsupported builds stay opaque. */
  nativeGlass?: boolean
  language: UiLanguage
  accent: AccentColor
  sendShortcut: SendShortcut
  /** Tool rows start expanded. */
  expandSteps: boolean
  linkOpen: LinkOpen
  /** Start the packaged app when the user logs in. Separate from background running. */
  launchAtLogin: boolean
  /** Permit this Mac's logged-in user to run automatic routines when the app is closed. */
  runRoutinesWhenClosed: boolean
  profileName: string
  /** App-owned raster image; empty/absent retains the legacy emoji and colour. */
  profileImage?: string
  profileEmoji: string
  profileColor: string
  /** Desktop notifications for approvals, help, and failures. */
  notifications: boolean
  /** Notify after a successful public AI reply in foreground and background. */
  notifyOnTurn: boolean
  /** On-device dictation locale; system follows macOS. */
  voiceLanguage?: string
  /** Optional skill-based development review. Legacy settings keep it off. */
  decisionSkillReview?: boolean
  updateChannel: UpdateChannel
  defaultBackendId: string
  defaultModelId: string
  /**
   * Thinking depth for Bots that follow the defaults. Absent leaves the
   * depth to the CLI or provider. A Bot that picks its own source stores
   * the depth on the Bot instead.
   */
  defaultThinking?: ThinkingDepth
  defaultMode: AgentMode
  approvalPolicy: ApprovalPolicy
  /** Local file/process access. Absent only in legacy data; migrated on load. */
  localExecutionPolicy?: LocalExecutionPolicy
  /** Apply automatic permission decisions; off routes governed actions to the user. */
  automaticReview?: boolean
  /** Matching actions always require a fresh human decision; never a deny rule. */
  asklist?: string[]
  /** Versioned natural-language review rules; old pattern lists stay intact. */
  semanticPermissionRules?: SemanticPermissionRule[]
  /** Shell commands auto-approved without prompting. */
  allowlist: string[]
  /** Shell commands always refused. */
  denylist: string[]
  /** Global custom instructions, prepended for every bot. */
  rules: string
  /** Optional tool-free routing advice; never replaces a Bot's chosen model. */
  quickDecision?: { backendId: string; modelId: string } | null
  backends: Record<string, BackendConfig>
  mcpServers: McpServerConfig[]
  /**
   * AGENTS.md file ids assigned to each local CLI (Codex, Kimi, and the rest).
   * This is not a per-Bot allowlist. A Bot receives the files for the local CLI
   * that is running the turn.
   */
  localCliAgentsMd?: Record<string, string[]>
  /** Installed Apps are GitHub, Gmail, and X. One connection, shared by every Bot. */
  apps: AppLinks
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

/** A form saves one MCP connection against the current list, not an old snapshot. */
export interface McpServerEdit { server: McpServerConfig; editingId?: string }
export type McpServerSaveResult = { ok: true; settings: Settings } | { ok: false; error: string }

export type UserProfilePatch = Partial<Pick<Settings, 'profileName' | 'profileImage'>>
export type UserProfileSaveResult = { ok: true; settings: Settings } | { ok: false; error: string }

export type PermissionRuleList = 'asklist' | 'allowlist' | 'denylist' | 'computerUseAllowedApps'
export type PermissionEdit =
  | { kind: 'options'; localExecutionPolicy?: LocalExecutionPolicy; automaticReview?: boolean }
  | { kind: 'rule'; list: PermissionRuleList; value: string; previous?: string; remove?: boolean }
  | { kind: 'semantic-rule'; rule: SemanticPermissionRule; previous?: SemanticPermissionRule; remove?: boolean }
export type PermissionSaveResult = { ok: true; settings: Settings } | { ok: false; error: string }
