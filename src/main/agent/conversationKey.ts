/**
 * The isolation boundary for a CLI's own persisted conversation.
 *
 * A session-based agent CLI keys its stored thread on whatever we hand it, and
 * the OpenBOT session id alone is NOT enough. Two bots in one session were
 * handed the same key and shared a single Claude Code conversation: the second
 * bot resumed the first's thread and inherited its turns as its own, so the two
 * personas cross-contaminated inside one chat — each answering as if it had
 * written what the other said.
 *
 * Everything that must not be shared goes in: the backend, the session, the
 * bot, the working directory and the model. That is the same boundary a pooled
 * CLI *process* would need, which is not a coincidence — both are asking "whose
 * history is this?".
 */

import type { Bot, Session } from '../../shared/types'

export function conversationKey(session: Session, bot: Bot): string {
  return JSON.stringify([
    bot.backendId ?? '',
    session.id ?? '',
    bot.id ?? '',
    session.cwd ?? '',
    bot.modelId ?? '',
    bot.thinking ?? ''
  ])
}
