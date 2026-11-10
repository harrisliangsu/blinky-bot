/**
 * Sessions — a transactional message store with separately stored images.
 *
 * The cache is authoritative; every mutation bumps `updatedAt` and commits to
 * the database. The agent loop mutates sessions through the helpers at the
 * bottom of this file, which keeps persistence and event broadcasting apart.
 */

import { randomUUID } from 'node:crypto'
import type { AgentMode, Message, Session, SessionSummary, TodoItem } from '../../shared/types'
import { getSettings } from '../settings'
import { SessionCollection } from './sessionCollection'
import { defaultBotId } from './bots'
import { forgetBindingsForSession } from './providerBindings'
import { defaultCwd, normaliseTodos, stringList } from './sessionSchema'
import { createConversationWorkspace } from './conversationWorkspace'

const collection = new SessionCollection()
export const sessionsLoadWasIncomplete = (): boolean => collection.loadWasIncomplete

export async function loadSessions(): Promise<void> {
  await collection.load()
}

/* ── queries ─────────────────────────────────────────────────────── */

/** Summaries for the sidebar, most recently updated first. */
export function listSessions(): SessionSummary[] {
  return collection
    .entries()
    .map(({ session, messageCount }) => {
      const summary: SessionSummary = {
        id: session.id,
        title: session.title,
        botIds: [...session.botIds],
        updatedAt: session.updatedAt,
        messageCount
      }
      if (session.archived) summary.archived = true
      if (session.projectId) summary.projectId = session.projectId
      return summary
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(id: string): Session | null {
  return collection.get(id)
}
export function isSessionMessageDurable(sessionId: string, messageId: string): boolean {
  return collection.hasMessage(sessionId, messageId)
}

/** Read a specific image belonging to a specific conversation and message. */
export function getSessionAttachmentData(sessionId: string, messageId: string, attachmentId: string): string | null {
  const attachment = getSession(sessionId)?.messages.find((message) => message.id === messageId)?.attachments?.find((item) => item.id === attachmentId && item.kind === 'image')
  return attachment?.data ?? (attachment?.dataRef ? collection.blob(attachment.dataRef) : null)
}

/** Bound the image payloads sent to a model while retaining the text history. */
export function hydrateRecentImages(session: Session): Session {
  let remainingAttachments = 6
  let remainingScreenshots = 4
  const messages = [...session.messages]
  for (let i = messages.length - 1; i >= 0 && (remainingAttachments || remainingScreenshots); i--) {
    const message = messages[i]
    let changed = false
    const attachments = message.attachments?.map((item) => {
      if (remainingAttachments && item.kind === 'image' && item.dataRef && !item.data) {
        const data = collection.blob(item.dataRef)
        if (!data) throw new Error('A saved image could not be read.')
        remainingAttachments--; changed = true
        return { ...item, data }
      }
      return item
    })
    let toolResult = message.toolResult
    if (remainingScreenshots && toolResult?.screenshotRef && !toolResult.screenshot) {
      const screenshot = collection.blob(toolResult.screenshotRef)
      if (!screenshot) throw new Error('A saved screenshot could not be read.')
      toolResult = { ...toolResult, screenshot }
      remainingScreenshots--; changed = true
    }
    if (changed) messages[i] = { ...message, attachments, toolResult }
  }
  return { ...session, messages }
}

/** Every session in full — for the agent loop and exchange bookkeeping. */
export function allSessions(): Session[] {
  return collection.all()
}

/* ── mutations ───────────────────────────────────────────────────── */

/**
 * Persist a session as-is, bumping `updatedAt`.
 *
 * Message rows and image references commit atomically. Image files are written
 * before the transaction references them; legacy JSON files remain untouched.
 */
export function saveSession(session: Session): Session {
  return collection.put({ ...session, updatedAt: Date.now() })
}

function mutate(id: string, fn: (session: Session) => Session): Session | null {
  const existing = collection.get(id)
  if (!existing) return null
  return collection.put({ ...fn(existing), id: existing.id, updatedAt: Date.now() })
}

export function createSession(botIds?: string[], cwd?: string): Session {
  const requested = stringList(botIds)
  const fallback = defaultBotId()
  const ids = requested.length > 0 ? requested : fallback ? [fallback] : []
  const now = Date.now()
  const id = randomUUID()
  return collection.put({
    id,
    title: 'New Chat',
    cwd: cwd ?? createConversationWorkspace(ids, id),
    mode: getSettings().defaultMode,
    botIds: ids,
    activeBotId: ids[0] ?? '',
    messages: [],
    todos: [],
    createdAt: now,
    updatedAt: now
  })
}

export function renameSession(id: string, title: string): Session | null {
  const clean = title.trim().slice(0, 200)
  return mutate(id, (session) => ({ ...session, title: clean || session.title }))
}

export function archiveSession(id: string): Session | null {
  return mutate(id, (session) => ({ ...session, archived: true }))
}

/**
 * Empty the transcript and drop CLI resume ids.
 *
 * The conversation id, working directory, mode and project stay, and so does
 * the bot's memory. The next turn starts a fresh CLI thread and can hand it
 * whatever is still in this session — which, after this, is nothing until the
 * user speaks again.
 */
export function clearSessionTranscript(id: string): Session | null {
  const session = mutate(id, (current) => ({ ...current, messages: [], todos: [] }))
  if (session) forgetBindingsForSession(id)
  return session
}

export function unarchiveSession(id: string): Session | null {
  return mutate(id, (session) => {
    const next = { ...session }
    delete next.archived
    return next
  })
}

export function removeSession(id: string): boolean {
  return collection.delete(id)
}

export function setSessionMode(id: string, mode: AgentMode): Session | null {
  return mutate(id, (session) => ({ ...session, mode }))
}

export function setSessionCwd(id: string, cwd: string): Session | null {
  return mutate(id, (session) => ({ ...session, cwd }))
}

export function addBotToSession(id: string, botId: string): Session | null {
  return mutate(id, (session) => {
    if (session.botIds.includes(botId)) return session
    return {
      ...session,
      botIds: [...session.botIds, botId],
      activeBotId: session.activeBotId || botId
    }
  })
}

export function removeBotFromSession(id: string, botId: string): Session | null {
  return mutate(id, (session) => {
    const botIds = session.botIds.filter((entry) => entry !== botId)
    return {
      ...session,
      botIds,
      activeBotId: session.activeBotId === botId ? (botIds[0] ?? '') : session.activeBotId
    }
  })
}

/** Remove a deleted bot from every chat that still references it. */
export function removeBotFromAllSessions(botId: string): Session[] {
  if (!botId) return []
  const touched: Session[] = []
  for (const { session } of collection.entries()) {
    if (!session.botIds.includes(botId) && session.activeBotId !== botId) continue
    const next = removeBotFromSession(session.id, botId)
    if (next) touched.push(next)
  }
  return touched
}

/**
 * Give the floor to a bot that is already part of this chat.
 *
 * The roster check is the last line of defence, not the first — `agent/handoff.ts`
 * refuses an outside target with a message the model can read. This one is silent
 * (a null, as for a session that is gone) and exists because a bare `mutate` here
 * made every caller that forgot to validate into a way of pointing a chat at any
 * bot in the app; the MCP gateway was exactly that caller.
 */
export function setActiveBot(id: string, botId: string): Session | null {
  const session = collection.get(id)
  if (!session || !session.botIds.includes(botId)) return null
  return mutate(id, (existing) => ({ ...existing, activeBotId: botId }))
}

/** File a chat into a project, or pass null to make it a loose chat again. */
export function setSessionProject(id: string, projectId: string | null): Session | null {
  return mutate(id, (session) => {
    const next = { ...session }
    if (projectId) next.projectId = projectId
    else delete next.projectId
    return next
  })
}

/**
 * Unfile every chat belonging to `projectId`, persisting each one.
 *
 * Called when a project is deleted: without this the chats keep pointing at an
 * id that is gone, which shows them in neither the project nor the loose-chat
 * list. Returns the sessions that changed, so the caller can announce them.
 */
export function unfileSessionsFrom(projectId: string): Session[] {
  if (!projectId) return []
  const touched: Session[] = []
  for (const { session } of collection.entries()) {
    if (session.projectId !== projectId) continue
    const next = setSessionProject(session.id, null)
    if (next) touched.push(next)
  }
  return touched
}

/**
 * Unfile every chat whose project no longer exists.
 *
 * A chat filed into a project that was deleted before the cascade existed shows
 * up in neither the project nor the loose-chat list — it is invisible but not
 * gone. Run once at startup, with both collections loaded, so those chats come
 * back. Returns the sessions that changed.
 */
export function unfileOrphanedSessions(projectExists: (id: string) => boolean): Session[] {
  const touched: Session[] = []
  for (const { session } of collection.entries()) {
    const projectId = session.projectId
    if (!projectId || projectExists(projectId)) continue
    const next = setSessionProject(session.id, null)
    if (next) touched.push(next)
  }
  return touched
}

/* ── helpers for the agent loop ──────────────────────────────────── */

/** Append a message. Returns the updated session, or null if it is gone. */
export function appendMessage(sessionId: string, message: Message): Session | null {
  return mutate(sessionId, (session) => ({ ...session, messages: [...session.messages, message] }))
}

/** Shallow-patch one message in place. */
export function updateMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>
): Session | null {
  return mutate(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId ? { ...message, ...patch, id: message.id } : message
    )
  }))
}

export function toggleMessageReaction(sessionId: string, messageId: string, emoji: string, actor = 'You'): Session | null {
  const cleanEmoji = emoji.trim().slice(0, 16)
  const cleanActor = actor.trim().slice(0, 80) || 'You'
  if (!cleanEmoji) return getSession(sessionId)
  return mutate(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) => {
      if (message.id !== messageId) return message
      const reactions = { ...(message.reactions ?? {}) }
      const people = [...(reactions[cleanEmoji] ?? [])]
      const index = people.indexOf(cleanActor)
      if (index >= 0) people.splice(index, 1)
      else people.push(cleanActor)
      if (people.length > 0) reactions[cleanEmoji] = people
      else delete reactions[cleanEmoji]
      return { ...message, reactions }
    })
  }))
}

export function removeMessage(sessionId: string, messageId: string): Session | null {
  return mutate(sessionId, (session) => ({
    ...session,
    messages: session.messages.filter((message) => message.id !== messageId)
  }))
}

export function setTodos(sessionId: string, todos: TodoItem[]): Session | null {
  return mutate(sessionId, (session) => ({ ...session, todos: normaliseTodos(todos) }))
}

/** Patch arbitrary session fields; identity and creation time stay ours. */
export function updateSession(id: string, patch: Partial<Session>): Session | null {
  return mutate(id, (session) => ({ ...session, ...patch, createdAt: session.createdAt }))
}

/** Conventional name the agent loop resolves `saveSession` by. */
export const save = saveSession
