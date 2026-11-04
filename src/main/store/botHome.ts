/**
 * The conversation a bot opens, and the one background work posts into.
 *
 * A bot has one home. Upgrade picks it once (newest open chat that includes
 * the bot) and writes `activeConversationId`. Later launches keep that binding.
 * Chats that are nobody's home are archived, including older collab sessions.
 */

import { latestChatForBot, planActiveConversations } from '../../shared/activeConversation'
import type { Session } from '../../shared/types'
import { getBot, listBots, releaseConversation, updateBot } from './bots'
import { archiveSession, createSession, getSession, listSessions, saveSession } from './sessions'

export function migrateBotHomes(): { assigned: number; archived: number } {
  const plan = planActiveConversations(
    listBots().map((bot) => ({ id: bot.id, activeConversationId: bot.activeConversationId })),
    listSessions()
  )
  for (const assignment of plan.assign) {
    updateBot(assignment.botId, { activeConversationId: assignment.conversationId })
  }
  for (const id of plan.archiveIds) archiveSession(id)
  return { assigned: plan.assign.length, archived: plan.archiveIds.length }
}

/** The bot's home chat, creating one when it has none. */
export function ensureBotHome(botId: string): Session | null {
  if (!botId) return null
  const bot = getBot(botId)
  if (!bot) return null
  const bound = bot.activeConversationId ? getSession(bot.activeConversationId) : null
  if (bound && !bound.archived && bound.botIds.includes(botId)) return bound
  const picked = latestChatForBot(listSessions(), botId)
  if (picked) {
    const session = getSession(picked.id)
    if (session) {
      updateBot(botId, { activeConversationId: session.id })
      return session
    }
  }
  const created = createSession([botId])
  updateBot(botId, { activeConversationId: created.id })
  return created
}

/**
 * Archive the current chat, then open an empty one with the same folder,
 * mode, project and bots. The archived transcript keeps its CLI binding.
 * The new chat has none, so the next turn starts fresh.
 */
export function archiveAndClearSession(id: string): { previous: Session | null; next: Session | null } {
  const existing = getSession(id)
  if (!existing) return { previous: null, next: null }
  const previous = archiveSession(id)
  releaseConversation(id)
  const created = createSession(existing.botIds)
  const draft: Session = {
    ...created,
    cwd: existing.cwd,
    mode: existing.mode,
    messages: [],
    todos: []
  }
  if (existing.projectId) draft.projectId = existing.projectId
  const next = saveSession(draft)
  for (const botId of next.botIds) {
    const bot = getBot(botId)
    if (!bot) continue
    if (!bot.activeConversationId || bot.activeConversationId === id) {
      updateBot(botId, { activeConversationId: next.id })
    }
  }
  return { previous, next }
}
