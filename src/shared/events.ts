/**
 * The canonical event union: main → renderer.
 *
 * Every backend, whatever its native protocol, normalises into these events.
 * That is what makes local servers, agent CLIs and cloud APIs interchangeable
 * to the UI. Treat this union as the contract to extend, not to bypass.
 */

import type { AgentTrace, Message, ToolCall, ToolResult } from './chat'
import type { MemoryEntry } from './bots'
import type { RecordingState, Routine, RoutineStep } from './routines'
import type { Settings } from './settings'
import type { Session, SessionSummary, TodoItem } from './sessions'
import type { ApprovalRequest } from './tools'
import type { ActivityItem, AgentTask, AgentTaskSummary } from './activity'
import type { BackendInfo } from './backends'
import type { MessageQueue } from './messageQueue'

export interface HumanHelpRequest {
  id: string
  sessionId: string
  botId: string
  reason: string
  createdAt: number
}

export type AgentEvent =
  | { type: 'room-devices-changed'; roomId: string }
  | { type: 'workspace-updated'; area: string }
  | { type: 'message-queue-updated'; queue: MessageQueue }
  | { type: 'run-started'; sessionId: string }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-summary-updated'; summary: SessionSummary }
  | { type: 'task-summary-updated'; task: AgentTaskSummary }
  | { type: 'message-start'; sessionId: string; message: Message }
  | { type: 'message-updated'; sessionId: string; message: Message; moveToEnd: boolean }
  | { type: 'message-removed'; sessionId: string; messageId: string }
  | { type: 'text-delta'; sessionId: string; messageId: string; delta: string; segment?: { id: string; phase: 'commentary' | 'partial_answer' | 'final_answer'; delta: string; text?: string } }
  | { type: 'reasoning-delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'agent-trace'; sessionId: string; messageId: string; entry: AgentTrace }
  | { type: 'backend-notice'; sessionId: string; category: 'reconnect' | 'transport' | 'warning'; message: string }
  | { type: 'tool-call'; sessionId: string; messageId: string; call: ToolCall }
  | { type: 'tool-result'; sessionId: string; messageId: string; result: ToolResult }
  /**
   * `content` is the committed text, which can differ from what was streamed —
   * the multi-bot ACTION line is protocol, not content, and is stripped before
   * storage. The UI must adopt this rather than keep the raw stream.
   */
  | { type: 'message-end'; sessionId: string; messageId: string; content?: string; displayContent?: string; segments?: Message['segments']; toolCalls?: Message['toolCalls']; error?: string; internal?: boolean }
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
  | { type: 'approval-resolved'; requestId: string; sessionId: string }
  | { type: 'handoff'; sessionId: string; fromBotId: string; toBotId: string; reason: string }
  | { type: 'human-help-request'; request: HumanHelpRequest }
  | { type: 'human-help-resolved'; requestId: string; sessionId: string }
  | { type: 'activity-updated'; item: ActivityItem }
  | { type: 'task-updated'; task: AgentTask }
  | { type: 'task-clarification-updated'; request: import('./activity').AgentTaskClarification }
  | { type: 'send-rules-updated' }
  | { type: 'routine-updated'; routine: Routine }
  | { type: 'github-draft-updated'; draft: import('./drafts').GitHubCommentDraft }
  | { type: 'gmail-draft-updated'; draft: import('./drafts').GmailDraft }
  | { type: 'calendar-draft-updated'; draft: import('./drafts').CalendarDraft }
  | { type: 'x-draft-updated'; draft: import('./drafts').XDraft }
  | { type: 'slack-draft-updated'; draft: import('./drafts').SlackDraft }
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
  | { type: 'done'; sessionId: string; outcome?: 'completed' | 'cancelled' | 'failed' }
