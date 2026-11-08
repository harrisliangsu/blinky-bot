/** Persistent local inbox and independently running agent tasks. */

export type ActivityKind = 'info' | 'approval' | 'help' | 'completed' | 'failed'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  title: string
  detail: string
  read: boolean
  createdAt: number
  sessionId?: string
  botId?: string
}

export type AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** A lead's assessment is a claim, not proof that the user's objective is complete. */
export interface AgentTaskReview {
  outcome: 'complete_claimed' | 'blocked'
  summary: string
  evidence: string[]
  recordedAt: number
  /** Checks actually performed by the application, not proof of the whole goal. */
  verifiedFiles?: Array<{ path: string; sha256?: string }>
}

/** An optional, narrowly scoped check for an output explicitly requested by the user. */
export interface AgentTaskAcceptance {
  root: string
  files: Array<{ path: string; sha256?: string }>
}

export interface AgentTask {
  id: string
  botId: string
  prompt: string
  title: string
  status: AgentTaskStatus
  sessionId: string
  createdAt: number
  updatedAt: number
  plan?: import('./taskPlan').TaskPlan
  planInvalid?: boolean
  workspace?: import('./taskPlan').TaskWorkspace
  sessionChoice?: import('./taskPlan').TaskSessionChoice
  error?: string
  /** Home chat of the lead; absent for legacy Bot-to-Bot tasks. */
  sourceSessionId?: string
  /** The lead Bot which delegated work to a teammate in sourceSessionId. */
  requesterBotId?: string
  executionAgent?: { backendId: string; modelId: string; thinking?: import('./thinking').ThinkingDepth }
  /** The prior execution attempt whose private conversation this one continues. */
  continuedFromTaskId?: string
  acceptance?: AgentTaskAcceptance
  /** Malformed saved checks must not silently disappear on restart. */
  acceptanceInvalid?: boolean
  result?: string
  review?: AgentTaskReview
  deliveryStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}

/** Navigation payload: no request, transcript, result or review evidence. */
export type AgentTaskSummary = Omit<AgentTask, 'prompt' | 'result' | 'review' | 'acceptance'> & { hasReview?: boolean }

export function summariseTask(task: AgentTask): AgentTaskSummary {
  const { prompt: _prompt, result: _result, review, acceptance: _acceptance, ...summary } = task
  return { ...summary, hasReview: Boolean(review) }
}

/** Delivery is confirmed by the transport, separately from the executor's answer. */
export interface AgentTaskMessageReceipt {
  requestId: string
  taskId: string
  text: string
  status: 'queued' | 'delivering' | 'delivered' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  delivery?: 'live' | 'turn_boundary'
  direction?: 'to_executor' | 'to_lead'
  /** Compare retries without persisting the original private input. */
  fingerprint?: string
}

export interface AgentTaskQuestion {
  id: string
  header: string
  question: string
  options?: Array<{ label: string; description: string }>
  /** Implementation choices may be decided by the owning Bot; authorization never is. */
  kind?: 'fact' | 'implementation' | 'preference' | 'authorization'
  isOther?: boolean
  isSecret?: boolean
}

export interface AgentTaskAnswerEvidence {
  kind: 'user_fact' | 'tool_observation' | 'implementation_decision'
  sessionId?: string
  messageId?: string
  toolName?: string
  callId?: string
  quote?: string
  reason?: string
}

export interface AgentTaskClarification {
  id: string
  taskId: string
  sourceSessionId: string
  executionSessionId: string
  /** Original lead Bot, never the currently selected Bot in the interface. */
  botId: string
  taskTitle?: string
  questions: AgentTaskQuestion[]
  status: 'answering' | 'waiting_user' | 'answered' | 'cancelled' | 'expired' | 'failed'
  createdAt: number
  updatedAt: number
  answers?: Record<string, string[]>
  answeredBy?: 'bot' | 'user'
  /** Bot decisions are recorded separately from source-grounded facts. */
  answerBasis?: 'context' | 'implementation'
  answerEvidence?: Record<string, AgentTaskAnswerEvidence>
  /** Why owning-Bot inference could not run; never contains raw provider errors. */
  botResolutionUnavailable?: 'permission-required' | 'local-execution-denied' | 'native-tools-unavailable' | 'inference-unavailable'
  persistenceError?: string
  botAnswers?: Record<string, string[]>
  error?: string
}

export interface AgentTaskCommand {
  action: 'list' | 'inspect' | 'message' | 'stop' | 'resume' | 'report' | 'prioritize' | 'match' | 'describe'
  taskId?: string
  text?: string
  requestId?: string
  limit?: number
  before?: string
  priority?: import('./taskPlan').TaskPriority
  dependencies?: string[]
  reason?: string
  context?: import('./taskContext').TaskContextInput
}
