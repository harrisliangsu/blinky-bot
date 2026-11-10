/**
 * Which Codex app-server call opens the thread for this turn.
 *
 * `thread/start` creates a thread. `thread/resume` loads one Codex already
 * stored by id. Passing `history` or a non-empty `path` outranks `threadId`
 * and would throw away the stored transcript; safety overrides can still
 * accompany the id. The server process does not have to stay up
 * between turns: Codex writes the thread to disk and the next process loads it.
 *
 * A resume that fails is not a reconnect. `error` notifications with
 * `willRetry: true` stay inside `codexEvents` and must not reach this choice.
 * When resume itself fails and the turn was not cancelled, the binding is
 * dropped and the same process starts a fresh thread with the in-app transcript.
 */

import type { ProviderMessage } from '../types'
import { deliveredFingerprints, forgetProviderBinding, getProviderBinding, putProviderBinding } from '../../store/providerBindings'
import { fingerprints, firstUnsent } from './resumePrompt'
import { flattenTranscript, latestUserTurn } from './transcript'

/** Codex thread ids travel in JSON-RPC, not in argv, but they are still tokens. */
export function durableThreadId(id: string | undefined): string | undefined {
  if (!id) return undefined
  const clean = id.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(clean)) return undefined
  return clean
}

export function rememberedCodexThread(sessionKey: string | undefined): string | undefined {
  return durableThreadId(getProviderBinding('codex', sessionKey)?.nativeThreadId)
}

export function rememberCodexThread(sessionKey: string | undefined, threadId: string): void {
  const clean = durableThreadId(threadId)
  if (!sessionKey || !clean) return
  putProviderBinding('codex', sessionKey, { nativeThreadId: clean })
}

export function forgetCodexThread(sessionKey: string | undefined): void {
  forgetProviderBinding('codex', sessionKey)
}

export interface CodexThreadCall {
  method: 'thread/start' | 'thread/resume'
  params: { threadId?: string; cwd?: string; model?: string; approvalPolicy?: 'never' | 'untrusted' | 'on-request'; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalsReviewer?: 'auto_review' | 'user' }
}

export function codexThreadCall(input: { threadId?: string; cwd?: string; model?: string; approvalPolicy?: 'never' | 'untrusted' | 'on-request'; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalsReviewer?: 'auto_review' | 'user' }): CodexThreadCall {
  const safety = { ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}), ...(input.sandbox ? { sandbox: input.sandbox } : {}), ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}) }
  const threadId = durableThreadId(input.threadId)
  if (threadId) return { method: 'thread/resume', params: { threadId, ...safety } }
  const model = input.model && input.model !== 'default' ? input.model : undefined
  return {
    method: 'thread/start',
    params: {
      ...safety,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(model ? { model } : {})
    }
  }
}

export function threadIdOf(response: { threadId?: string; thread?: { id?: string } } | null | undefined): string | undefined {
  return durableThreadId(response?.threadId ?? response?.thread?.id)
}

/**
 * Resume failed and the user did not cancel: start a new thread and hand it
 * the transcript. An abort must not drop the binding or open a second thread.
 */
export function shouldRetryCodexThread(input: { hadThread: boolean; aborted: boolean }): boolean {
  return input.hadThread && !input.aborted
}

/**
 * Prompt for this turn.
 *
 * A new thread receives the transcript, which is the handoff when resume
 * failed and the binding was dropped. A resumed thread receives only the
 * suffix it has not been given. With no watermark — a binding restored from
 * disk that never recorded one — the suffix is the whole transcript, which
 * repeats history rather than dropping it.
 */
export function codexTurnPrompt(messages: ProviderMessage[], sessionKey: string | undefined, resuming: boolean): string {
  if (!resuming) return flattenTranscript(messages, { images: 'inline' })
  const marks = fingerprints(messages)
  const previous = deliveredFingerprints(sessionKey)
  // Contextual memory and user rules can change the initial system message on
  // every turn. Match the conversation after that message independently;
  // otherwise a changed system fingerprint makes firstUnsent return zero and
  // replays every old user request into the already resumed Codex thread.
  if (messages[0]?.role === 'system' && previous.length > 0 && marks[0] !== previous[0] &&
      (previous.length === 1 || (marks.length > 1 && marks[1] === previous[1]))) {
    let i = 1
    while (i < previous.length && i < marks.length && previous[i] === marks[i]) i++
    const fresh = messages.slice(i)
    return flattenTranscript([messages[0], ...fresh], { images: 'inline' })
  }
  const fresh = messages.slice(firstUnsent(sessionKey, marks))
  const delta = fresh.length ? flattenTranscript(fresh, { images: 'inline' }) : latestUserTurn(messages)
  return delta.trim() ? delta : flattenTranscript(messages)
}
