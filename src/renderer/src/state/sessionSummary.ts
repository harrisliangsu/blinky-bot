/**
 * The sidebar's view of a session.
 *
 * Every field is derived from the full session, which is why an update
 * *replaces* the stored summary rather than merging over it — a merge could add
 * a chat's project filing but never clear it.
 */

import type { Session, SessionSummary } from '../../../shared/types'
import { store } from './core'
import { summariseSession } from '../../../shared/sessionSummary'


/**
 * Replace the summary outright rather than merging over it.
 *
 * `summaryOf` omits `projectId` when the chat is unfiled, so spreading the new
 * summary on top of the old one could add filing but never clear it. Deleting a
 * project unfiles its chats and broadcasts one update each; the renderer kept
 * the stale id, the project row was gone, and the sidebar filtered those chats
 * out of the top-level list too — they vanished entirely until a restart, while
 * being perfectly intact on disk.
 *
 * Every field of a summary is derived from the session, so there is nothing in
 * the old one worth keeping.
 */
function mergeSummary(session: Session): void {
  mergeSessionSummary(summariseSession(session))
}

export function mergeSessionSummary(next: SessionSummary): void {
  const { sessions } = store.getState()
  store.patch({
    sessions: sessions.some((x) => x.id === next.id)
      ? sessions.map((x) => (x.id === next.id ? next : x))
      : [next, ...sessions]
  })
}

export { mergeSummary }
