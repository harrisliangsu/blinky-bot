/** IPC for `OpenBotApi.sessions`. */

import { randomUUID } from 'node:crypto'
import { isRunning } from '../agent/cancel'
import { stopWarmCodexForSession } from '../backends/cli/codexAppServer'
import type { Session, SessionSummary } from '../../shared/types'
import { archiveAndClearSession, ensureBotHome } from '../store/botHome'
import { defaultBotId, getBot, updateBot } from '../store/bots'
import { getProject, unlinkSessionFromCards } from '../store/projects'
import { removeRoom, sharedRooms } from '../store/rooms'
import { roomAccess } from '../collaboration/access'
import { stopCollaborationServer } from '../collaboration/server'
import {
  addBotToSession,
  archiveSession,
  unarchiveSession,
  clearSessionTranscript,
  createSession,
  getSession,
  getSessionAttachmentData,
  listSessions,
  removeBotFromSession,
  removeSession,
  renameSession,
  setActiveBot,
  setSessionCwd,
  setSessionMode,
  setSessionProject,
  toggleMessageReaction
} from '../store/sessions'
import { defaultCwd } from '../store/sessionSchema'
import { sessionsLoadWasIncomplete } from '../store/sessions'
import { unreadableRecord } from './readFailure'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { observeSession } from './sessionObservation'
import { emptyArray, handle, handleEvent, handleVoid, nullResult } from './handler'
import { asAbsolutePath, asId, asIdArray, asMode, asOptionalId, asString } from './validate'

/** Shape returned when `create` fails outright, so the renderer still renders. */
function placeholderSession(): Session {
  const now = Date.now()
  return {
    id: randomUUID(),
    title: 'New Chat',
    cwd: defaultCwd(),
    mode: 'agent',
    botIds: [],
    activeBotId: '',
    messages: [],
    todos: [],
    createdAt: now,
    updatedAt: now
  }
}

/** Tell every window a session changed, so open views stay in step. */
function announce(session: Session | null): void {
  if (session) broadcast({ type: 'session-updated', session })
}

export function registerSessionIpc(): void {
  handleEvent(CHANNELS.sessionsWatch, (event, [slot, id]) => {
    if (slot !== 'chat' && slot !== 'agent') throw new TypeError('Unknown session observation slot')
    observeSession(event.sender, slot, id === null ? null : asId(id))
  }, unreadableRecord)
  handle<SessionSummary[]>(CHANNELS.sessionsList, () => listSessions(), emptyArray)

  handle<Session | null>(CHANNELS.sessionsGet, ([id]) => {
    const session = getSession(asId(id))
    if (!session && sessionsLoadWasIncomplete()) return unreadableRecord()
    return session
  }, unreadableRecord)
  handle<string | null>(CHANNELS.sessionsAttachment, ([id, messageId, attachmentId]) => getSessionAttachmentData(asId(id), asId(messageId), asId(attachmentId)), nullResult)

  handle<Session>(
    CHANNELS.sessionsCreate,
    ([botIds]) => {
      const requested = asIdArray(botIds)
      // One bot has one home. Creating "a chat" returns that home instead of
      // forking a second conversation the next launch would archive.
      let session = requested.length <= 1 ? ensureBotHome(requested[0] || defaultBotId()) : null
      if (!session) {
        session = createSession(requested)
        for (const botId of session.botIds) {
          const bot = getBot(botId)
          if (bot && !bot.activeConversationId) updateBot(botId, { activeConversationId: session.id })
        }
      }
      announce(session)
      return session
    },
    placeholderSession
  )

  handle<Session | null>(
    CHANNELS.sessionsClear,
    ([id]) => {
      const sessionId = asId(id)
      if (isRunning(sessionId)) throw new Error('Cannot clear a running conversation')
      stopWarmCodexForSession(sessionId)
      const session = clearSessionTranscript(sessionId)
      announce(session)
      return session
    },
    nullResult
  )

  handle<Session | null>(
    CHANNELS.sessionsArchiveAndClear,
    ([id]) => {
      const sessionId = asId(id)
      if (isRunning(sessionId)) throw new Error('Cannot clear a running conversation')
      stopWarmCodexForSession(sessionId)
      const { previous, next } = archiveAndClearSession(sessionId)
      if (previous) broadcast({ type: 'session-updated', session: previous })
      announce(next)
      return next
    },
    nullResult
  )

  handleVoid(CHANNELS.sessionsRename, ([id, title]) => {
    announce(renameSession(asId(id), asString(title, 200)))
  })

  handleVoid(CHANNELS.sessionsArchive, ([id]) => {
    announce(archiveSession(asId(id)))
  })

  /*
   * Deleting a chat closes any room shared from it.
   *
   * A room binds to a sessionId, and nothing cascaded: the room stayed enabled,
   * so `sharedRooms()` never emptied and the `0.0.0.0` listener stayed bound
   * for the life of the app. The Rooms panel went on listing a live invite URL
   * for a conversation that no longer existed.
   *
   * A kanban card binds to a sessionId the same way, and broke the same way:
   * the card kept the dead id, opening it failed forever, and nothing in the UI
   * could clear it.
   */
  handleVoid(CHANNELS.sessionsRemove, async ([id]) => {
    const sessionId = asId(id)
    removeSession(sessionId)
    unlinkSessionFromCards(sessionId)
    for (const room of sharedRooms()) {
      if (room.sessionId === sessionId && !roomAccess.hasWorkspaceAccess(room.id)) removeRoom(room.id)
    }
    if (sharedRooms().length === 0) await stopCollaborationServer()
  })

  handleVoid(CHANNELS.sessionsSetMode, ([id, mode]) => {
    announce(setSessionMode(asId(id), asMode(mode)))
  })

  handleVoid(CHANNELS.sessionsAddBot, ([id, botId]) => {
    announce(addBotToSession(asId(id), asId(botId)))
  })

  handleVoid(CHANNELS.sessionsRemoveBot, ([id, botId]) => {
    announce(removeBotFromSession(asId(id), asId(botId)))
  })

  handleVoid(CHANNELS.sessionsSetActiveBot, ([id, botId]) => {
    announce(setActiveBot(asId(id), asId(botId)))
  })

  handleVoid(CHANNELS.sessionsUnarchive, ([id]) => {
    announce(unarchiveSession(asId(id)))
  })

  handleVoid(CHANNELS.sessionsSetCwd, ([id, cwd]) => {
    announce(setSessionCwd(asId(id), asAbsolutePath(cwd)))
  })

  /** Null unfiles the chat. Filing into a project that is gone is refused. */
  handleVoid(CHANNELS.sessionsSetProject, ([id, projectId]) => {
    const target = asOptionalId(projectId) ?? null
    if (target && !getProject(target)) throw new TypeError(`unknown project: ${target}`)
    announce(setSessionProject(asId(id), target))
  })

  handleVoid(CHANNELS.sessionsReact, ([id, messageId, emoji, actor]) => {
    announce(toggleMessageReaction(asId(id), asId(messageId), asString(emoji, 16), actor === undefined ? 'You' : asString(actor, 80)))
  })
}
