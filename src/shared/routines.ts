/**
 * Routines: workflows captured by demonstration, then replayed.
 *
 * `literal` replays captured coordinates directly; `adaptive` re-derives each
 * step from its `intent` plus a fresh screenshot, which survives UI drift.
 */

export type RoutineStepKind =
  | 'observe'
  | 'click'
  | 'double_click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'open_app'
  | 'navigate'
  | 'wait'
  | 'tool'
  | 'assert'

export interface RoutineStep {
  id: string
  kind: RoutineStepKind
  /** Natural-language description, used when replaying adaptively. */
  intent: string
  /** Literal coordinates/keys captured at record time. */
  params?: Record<string, unknown>
  /** base64 PNG captured at record time, for visual re-anchoring. */
  reference?: string
}

export interface Routine {
  id: string
  botId: string
  name: string
  description: string
  steps: RoutineStep[]
  /** A natural-language task; recorded routines instead contain steps. */
  instruction?: string
  trigger: { kind: 'manual' | 'schedule' | 'once' | 'folder_change' | 'github_issue' | 'gmail_query' | 'webhook'; cron?: string; tz?: string; earlyMinutes?: number; lateMinutes?: number; at?: number; path?: string; owner?: string; repo?: string; issueNumber?: number; query?: string; account?: string; accountId?: string }
  replayMode: 'literal' | 'adaptive'
  createdAt: number
  lastRunAt?: number
  /** Disambiguates distinct event occurrences received at the same time. */
  lastRunId?: string
  lastRunState?: RoutineRun['status']
  lastRunError?: string
  notifyPolicy?: 'always' | 'on_change' | 'quiet'
  /** Read model attached by the routine IPC; never trusted as a stored patch. */
  runs?: RoutineRun[]
  runsError?: string
  /** Hash only: issue contents stay on GitHub. A first check establishes the baseline. */
  watchCursor?: string
  watchCheckedAt?: number
  watchError?: string
}

export interface RoutineRun {
  id: string
  routineId: string
  scheduledAt: number
  status: 'claimed' | 'running' | 'awaiting_review' | 'finished' | 'failed' | 'missed' | 'unknown' | 'skipped'
  startedAt?: number
  endedAt?: number
  detail?: string
  result?: string
  resultFingerprint?: string
  /** Observation order for results, separate from possibly equal event receipt times. */
  resultObservedAt?: number
  notificationState?: 'ready' | 'pending' | 'recorded' | 'quiet' | 'baseline' | 'unchanged' | 'uncertain'
  missedFrom?: number
  missedCount?: number
  taskIds?: string[]
  /** Authenticated event identity; received time is display-only, never its dedup key. */
  webhook?: { signalId: string; botId: string; sessionId: string }
}

export type RecordingState = 'idle' | 'recording' | 'paused'
