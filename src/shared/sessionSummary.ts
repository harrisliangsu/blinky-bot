import type { Session, SessionSummary } from './sessions'

export const summariseSession = (session: Session): SessionSummary => ({
  id: session.id, title: session.title, botIds: session.botIds,
  archived: session.archived, updatedAt: session.updatedAt,
  messageCount: session.messages.length,
  ...(session.projectId ? { projectId: session.projectId } : {})
})
