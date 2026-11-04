/**
 * The backend adapter contract.
 *
 * Every model source — a local server, an external agent CLI, or a cloud API —
 * implements exactly this interface. Nothing above this layer knows or cares
 * where inference actually runs.
 */

import type { CliAuthInfo } from '../../shared/cliAuth'
import type { ThinkingDepth } from '../../shared/thinking'
import type {
  BackendConfig,
  BackendKind,
  BackendStatus,
  ModelInfo,
  Role,
  ToolCall,
  ToolSchema
} from '../../shared/types'

export type { BackendConfig, BackendKind, BackendStatus, ModelInfo, ToolCall, ToolSchema }

/* ── Provider-neutral message shape ──────────────────────────────── */

export interface ProviderTextPart {
  type: 'text'
  text: string
}

export interface ProviderImagePart {
  type: 'image'
  /** e.g. `image/png`. */
  mime: string
  /** Raw base64 — never a `data:` URI. Adapters wrap it as the provider wants. */
  data: string
}

export type ProviderPart = ProviderTextPart | ProviderImagePart

/**
 * One turn, in a shape every provider can be projected from.
 * `tool` messages carry the result of a previous assistant tool call.
 */
export interface ProviderMessage {
  role: Role
  content: string | ProviderPart[]
  /** Assistant turns that called tools. */
  toolCalls?: ToolCall[]
  /** `tool` turns: which call this answers. */
  toolCallId?: string
  /** `tool` turns: the tool's name. */
  name?: string
  /** Assistant thinking, when the provider round-trips it. */
  reasoning?: string
  /** `tool` turns: whether the tool succeeded. */
  isError?: boolean
}

/* ── Chat ────────────────────────────────────────────────────────── */

/**
 * A permission an agent CLI wants granted mid-turn.
 *
 * Session-based CLIs run their own tool loop but ask the client before acting.
 * Routing that to OpenBOT's gate is the whole reason those transports are worth
 * having: with one-shot `exec` the CLI answers its own prompts internally and
 * the user never sees them.
 */
export interface BackendApproval {
  kind: 'shell' | 'edit' | 'write' | 'delete' | 'fetch' | 'mcp'
  /** One line, e.g. the command about to run. */
  summary: string
  /** Full text: command, diff, or target path. */
  detail: string
  /** Exact command/path/resource used for policy and denylist matching. */
  target?: string
  /** The adapter identified an irreversible or containment-crossing action. */
  force?: boolean
}

export type BackendApprovalDecision = 'approve' | 'approve-always' | 'reject'

export interface ChatRequest {
  model: string
  messages: ProviderMessage[]
  tools?: ToolSchema[]
  signal: AbortSignal
  temperature?: number
  /**
   * Supplied by the agent loop for session-based backends. Absent means the
   * caller cannot prompt, and adapters must fail closed — deny rather than
   * silently auto-approve.
   */
  approve?: (request: BackendApproval) => Promise<BackendApprovalDecision>
  /**
   * MCP servers the user configured. A CLI that can host MCP is given these so
   * the servers are actually reachable — they were previously accepted in
   * Settings and then never passed to anything.
   */
  mcpServers?: Array<{
    name: string
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
    /**
     * Bearer credential for an `http` server, carried apart from the URL so it
     * never reaches a process listing, a shell history or a log line. Adapters
     * put it wherever their CLI expects it — a header for Claude Code, an
     * environment variable for Codex.
     */
    bearerToken?: string
    auth?: 'none' | 'bearer' | 'oauth'
  }>
  /**
   * The user's approval policy, so a CLI that governs its own tools can be
   * held to it. Without this a CLI applies its OWN default, which may be more
   * permissive than what the user chose in OpenBOT.
   */
  approvalPolicy?: string
  /**
   * Folder this turn runs in — the session's working directory.
   *
   * Without it an agent CLI inherits `process.cwd()`, i.e. wherever Electron
   * was launched from, which silently ignores the folder the user chose.
   */
  cwd?: string
  /**
   * Stable key for the CONVERSATION this turn belongs to. Adapters whose CLI
   * can persist a conversation use it to continue rather than starting fresh,
   * so the agent keeps its own context between turns.
   *
   * It is an isolation boundary, not just a session id: the caller folds in
   * everything that must not be shared — backend, session, bot, folder, model.
   * Keyed on the session alone, two bots in one chat resumed each other's
   * thread and inherited each other's turns as their own.
   */
  sessionKey?: string
  /**
   * This request is a background side call: it must produce text and nothing
   * else. Adapters that can restrict their CLI to a read-only mode do.
   *
   * A "short side call" on an agent CLI is a whole second agent process, and it
   * ran under the session's own permission mode — `acceptEdits` — so a
   * post-turn memory extraction could edit the user's files unattended, after
   * the reply had already been reported and with nobody watching.
   */
  readOnly?: boolean
  /** Disable every CLI-owned tool; OpenBOT will execute supplied tools itself. */
  disableNativeTools?: boolean
  /**
   * How hard this turn should think. Adapters that cannot set a depth ignore
   * it. Absent leaves the CLI or provider on its own default.
   */
  thinking?: ThinkingDepth
}

/**
 * Token accounting for one turn, as the backend reports it.
 *
 * Agent CLIs manage their own context — they compact and prune without telling
 * us — so counting locally would drift. These are the CLI's own numbers.
 */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /** Tokens currently held in context, when the backend reports it. */
  totalTokens?: number
  cachedInputTokens?: number
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done' }

export interface DetectResult {
  status: BackendStatus
  detail?: string
  /** Agent CLIs only. The CLI owns the credential; this is the public state. */
  cliAuth?: CliAuthInfo
}

export interface Backend {
  id: string
  label: string
  kind: BackendKind
  local: boolean
  /** Safe model-only mode for a bot whose tool boundary is a private VM. */
  supportsVmOrchestration?: boolean
  detect(cfg: BackendConfig): Promise<DetectResult>
  listModels(cfg: BackendConfig): Promise<ModelInfo[]>
  chat(req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk>
}

/**
 * Runs a chat turn for one set of messages/tools.
 * Adapters hand this to the prompted-tool fallback so it can re-run a turn
 * with rewritten messages when the model has no native tool calling.
 */
export type ChatRunner = (
  messages: ProviderMessage[],
  tools: ToolSchema[] | undefined
) => AsyncIterable<ChatChunk>
