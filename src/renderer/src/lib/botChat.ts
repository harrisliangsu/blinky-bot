/**
 * Newest open chat that includes a bot.
 *
 * The durable home is `bot.activeConversationId`. This helper is the upgrade
 * rule and the fallback when that binding is missing or stale. Archived chats
 * stay under 更多.
 */
export { latestChatForBot } from '../../../shared/activeConversation'
