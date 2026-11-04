import type { SessionSummary } from '../../../shared/types'

/**
 * The conversation to open when a bot is selected.
 *
 * Navigation only: this does not create, merge, or compact anything. Summaries
 * are the same records the sidebar already holds, newest `updatedAt` wins, and
 * a chat counts when the bot is one of its participants. Archived chats are
 * skipped.
 */
export function latestChatForBot(sessions: readonly SessionSummary[], botId: string): SessionSummary | null {
  let best: SessionSummary | null = null
  for (const session of sessions) {
    if (session.archived) continue
    if (!session.botIds.includes(botId)) continue
    if (!best || session.updatedAt > best.updatedAt) best = session
  }
  return best
}
