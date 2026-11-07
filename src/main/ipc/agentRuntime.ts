/**
 * Lazy, failure-tolerant access to the agent loop.
 *
 * `src/main/agent/loop.ts` is owned by another module and is loaded on first
 * use rather than at boot: if it is missing, still building, or throws while
 * initialising, the window, the sidebar, settings and the whole store layer
 * keep working — only the agent-driven channels degrade, and they degrade into
 * an `error` event the UI can show.
 */

import type { ApprovalDecision, Attachment, Routine } from '../../shared/types'

export interface AgentLoopModule {
  receiveGitHubDraftResult(draft: import('../../shared/drafts').GitHubCommentDraft): Promise<void>
  receiveGmailDraftResult(draft: import('../../shared/drafts').GmailDraft): Promise<void>
  receiveCalendarDraftResult(draft: import('../../shared/drafts').CalendarDraft): Promise<void>
  receiveXDraftResult(draft: import('../../shared/drafts').XDraft): Promise<void>
  receiveSlackDraftResult(draft: import('../../shared/drafts').SlackDraft): Promise<void>
  sendMessage(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> | void
  receiveAgentResult(sessionId: string, taskId: string, title: string, result: string, onRecorded: () => Promise<void>): Promise<boolean>
  stopSession(sessionId: string): Promise<void> | void
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> | void
  runRoutine(routineId: string, sessionId: string): Promise<void> | void
  startRecording(botId: string, name: string): Promise<void> | void
  stopRecording(): Promise<Routine | null> | Routine | null
}

type PartialLoop = Partial<AgentLoopModule>

let cached: Promise<PartialLoop | null> | null = null

/**
 * Resolved at build time: the map is populated when the loop exists and empty
 * when it does not, so a missing peer module can never fail the build.
 */
// @ts-ignore `import.meta.glob` is a Vite build-time transform.
const candidates = import.meta.glob('../agent/loop.ts') as Record<
  string,
  () => Promise<unknown>
>

async function importLoop(): Promise<PartialLoop | null> {
  const load = Object.values(candidates)[0]
  if (!load) {
    console.warn('[openbot/ipc] agent loop is not part of this build')
    return null
  }
  try {
    return (await load()) as PartialLoop
  } catch (err) {
    console.warn('[openbot/ipc] agent loop unavailable:', err)
    return null
  }
}

/** Resolve the loop module, or null when it cannot be loaded. */
export function loadAgentLoop(): Promise<PartialLoop | null> {
  if (!cached) {
    cached = importLoop().then((module) => {
      // Do not memoise a failure: the next call gets a fresh attempt.
      if (!module) cached = null
      return module
    })
  }
  return cached
}

/**
 * Resolve one loop function. Returns null when the module or that particular
 * export is missing, so callers can report a precise reason.
 */
export async function loopFn<K extends keyof AgentLoopModule>(
  name: K
): Promise<AgentLoopModule[K] | null> {
  const module = await loadAgentLoop()
  const fn = module?.[name]
  return typeof fn === 'function' ? (fn as AgentLoopModule[K]) : null
}

export const AGENT_UNAVAILABLE =
  'The agent runtime is not available in this build. Chat history and settings still work.'
