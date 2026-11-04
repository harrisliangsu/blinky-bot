/**
 * The canonical event union: main → renderer.
 *
 * Every backend, whatever its native protocol, normalises into these events.
 * That is what makes local servers, agent CLIs and cloud APIs interchangeable
 * to the UI. Treat this union as the contract to extend, not to bypass.
 */

import type { Message, ToolCall, ToolResult } from './chat'
import type { MemoryEntry } from './bots'
import type { RecordingState, RoutineStep } from './routines'
import type { Settings } from './settings'
import type { Session, TodoItem } from './sessions'
import type { ApprovalRequest } from './tools'
import type { ActivityItem, AgentTask } from './activity'
import type { BackendInfo } from './backends'

export interface HumanHelpRequest {
  id: string
  sessionId: string
  botId: string
  reason: string
  createdAt: number
}

export type AgentEvent =
  | { type: 'session-updated'; session: Session }
  | { type: 'message-start'; sessionId: string; message: Message }
  | { type: 'text-delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'reasoning-delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'tool-call'; sessionId: string; messageId: string; call: ToolCall }
  | { type: 'tool-result'; sessionId: string; messageId: string; result: ToolResult }
  /**
   * `content` is the committed text, which can differ from what was streamed —
   * the multi-bot ACTION line is protocol, not content, and is stripped before
   * storage. The UI must adopt this rather than keep the raw stream.
   */
  | { type: 'message-end'; sessionId: string; messageId: string; content?: string }
  /**
   * Context accounting from the backend. Agent CLIs compact and prune their own
   * context, so these are their numbers rather than anything we count locally.
   */
  | {
      type: 'token-usage'
      sessionId: string
      usage: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        cachedInputTokens?: number
      }
      /** The active model's window, when known, so the UI can show a ratio. */
      contextWindow?: number
    }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'handoff'; sessionId: string; fromBotId: string; toBotId: string; reason: string }
  | { type: 'human-help-request'; request: HumanHelpRequest }
  | { type: 'human-help-resolved'; requestId: string; sessionId: string }
  | { type: 'activity-updated'; item: ActivityItem }
  | { type: 'task-updated'; task: AgentTask }
  | { type: 'memory-updated'; botId: string; entry: MemoryEntry }
  | { type: 'recording-state'; state: RecordingState; stepCount: number }
  | { type: 'recording-step'; step: RoutineStep }
  | { type: 'computer-frame'; sessionId: string; screenshot: string }
  /**
   * Settings changed in the main process rather than the renderer.
   *
   * The agent writes settings too — "always allow" persists a rule — and until
   * this existed the renderer never learned about it. Its permissions panel
   * kept showing the list it fetched at boot, and editing anything there sent
   * that stale array straight back, destroying the rules the agent had added.
   */
  | { type: 'settings-updated'; settings: Settings }
  /** A CLI login finished, or the window focused while one was still open. */
  | { type: 'backends-updated'; backends: BackendInfo[] }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'done'; sessionId: string }
