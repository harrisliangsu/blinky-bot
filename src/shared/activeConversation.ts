/**
 * One bot, one home conversation.
 *
 * The upgrade rule matches a bot click: the newest non-archived chat that
 * includes the bot. A binding that already points at a live chat of that bot
 * is kept, so a later launch does not reshuffle homes just because some other
 * chat was touched. Existing chats are left unchanged.
 */

export interface ConversationRef {
  id: string
  botIds: readonly string[]
  updatedAt: number
  archived?: boolean
}

export interface BotRef {
  id: string
  activeConversationId?: string
}

export interface ActiveConversationAssignment {
  botId: string
  conversationId: string
}

export interface ActiveConversationPlan {
  /** Bots whose stored home is missing or points at a chat that is not theirs. */
  assign: ActiveConversationAssignment[]
}

/** Newest non-archived chat that includes `botId`. Equal timestamps keep the first. */
export function latestChatForBot<T extends ConversationRef>(sessions: readonly T[], botId: string): T | null {
  if (!botId) return null
  let best: T | null = null
  for (const session of sessions) {
    if (session.archived) continue
    if (!session.botIds.includes(botId)) continue
    if (!best || session.updatedAt > best.updatedAt) best = session
  }
  return best
}

function boundHome(bot: BotRef, sessions: readonly ConversationRef[]): ConversationRef | null {
  if (!bot.activeConversationId) return null
  const bound = sessions.find((session) => session.id === bot.activeConversationId)
  if (!bound || bound.archived || !bound.botIds.includes(bot.id)) return null
  return bound
}

export function planActiveConversations(
  bots: readonly BotRef[],
  sessions: readonly ConversationRef[]
): ActiveConversationPlan {
  const homes = new Map<string, string>()
  for (const bot of bots) {
    const kept = boundHome(bot, sessions)
    const picked = kept ?? latestChatForBot(sessions, bot.id)
    if (picked) homes.set(bot.id, picked.id)
  }

  const assign: ActiveConversationAssignment[] = []
  for (const [botId, conversationId] of homes) {
    const bot = bots.find((item) => item.id === botId)
    if (bot?.activeConversationId !== conversationId) assign.push({ botId, conversationId })
  }
  return { assign }
}
