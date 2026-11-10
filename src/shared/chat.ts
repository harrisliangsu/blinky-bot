/** Core chat primitives: messages, tool calls, attachments. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  ok: boolean
  output: string
  /** Structured payload for rich renderers (diffs, screenshots, tables). */
  detail?: unknown
  /** base64 PNG, for computer-use tools that return a frame. */
  screenshot?: string
  /** Local image payload, loaded on demand from the session store. */
  screenshotRef?: string
  durationMs?: number
  /** Payloads were dropped to bound the session file — see `store/compaction.ts`. */
  compacted?: boolean
}

export interface Attachment {
  id: string
  kind: 'file' | 'image' | 'selection'
  name: string
  path?: string
  mime?: string
  data?: string
  /** Local image payload, loaded on demand from the session store. */
  dataRef?: string
}

export interface Message {
  id: string
  role: Role
  content: string
  /** Final user-facing part when a CLI interleaved its own tool progress. */
  displayContent?: string
  /** Separate Codex progress and answer items while retaining the full text. */
  segments?: Array<{ id: string; phase: 'commentary' | 'partial_answer' | 'final_answer'; text: string }>
  reasoning?: string
  /** Executor-only CLI events; redacted and never fed back as user chat. */
  agentTrace?: AgentTrace[]
  toolCalls?: ToolCall[]
  toolResult?: ToolResult
  attachments?: Attachment[]
  /** Which bot authored this turn, in a multi-bot exchange. */
  botId?: string
  /** Set when one bot hands work to another. */
  handoffTo?: string
  /** The message this one answers, when a bot is replying to a teammate. */
  replyTo?: string
  model?: string
  createdAt: number
  streaming?: boolean
  error?: string
  /** Internal orchestration message, sent to the model but not displayed as user text. */
  internal?: boolean
  /** Visible application status that must not be replayed to a model. */
  uiOnly?: boolean
  /** Emoji reactions keyed to local/LAN participant names. */
  reactions?: Record<string, string[]>
}

export interface AgentTrace {
  id: string
  kind: string
  phase: 'started' | 'completed'
  detail: string
}
