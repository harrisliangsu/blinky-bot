import type { AgentMode, Session } from '../../../shared/types'
import { latestChatForBot } from '../lib/botChat'
import { bridge, errText } from './bridge'
import { store } from './core'
import { loadProjects } from './projects'
import { EMPTY_IDS, EMPTY_TODOS } from './types'

/** Loads a full session into the message registry and makes it current. */
export function adoptSession(session: Session, preserveRun = false): void {
  const ids = store.resetMessages(session.messages)
  const { messages, todos, ...meta } = session
  const messageStreaming = messages.some((m) => m.streaming)
  store.patch({
    currentSessionId: session.id,
    session: meta,
    messageIds: ids,
    todos: todos ?? EMPTY_TODOS,
    // Usage is per-conversation and only arrives with a turn — showing the
    // previous session's numbers against this one would be wrong.
    usage: null,
    sessionLoading: false,
    runError: null,
    // A session snapshot is also broadcast between stages of one run (after
    // the user message, after a tool, before the final reply). Those persisted
    // messages are correctly non-streaming, but the run is still active and
    // may be waiting on an approval. Only a deliberate session selection gets
    // to reset that live run state; the terminal `done`/`error` event clears it.
    streaming: preserveRun
      ? store.getState().streaming || messageStreaming
      : messageStreaming
  })
}

export async function loadSessions(): Promise<void> {
  store.patch({ sessionsLoading: true })
  try {
    store.patch({ sessions: await bridge().sessions.list(), sessionsLoading: false, sessionsError: null })
  } catch (e) {
    store.patch({ sessionsLoading: false, sessionsError: errText(e) })
  }
}

export async function selectSession(id: string): Promise<void> {
  if (id === store.getState().currentSessionId) {
    store.patch({ modal: null, projectHome: null })
    return
  }
  // Opening a chat leaves the project home page behind.
  store.patch({ sessionLoading: true, currentSessionId: id, modal: null, runError: null, projectHome: null })
  try {
    const session = await bridge().sessions.get(id)
    // A slower earlier click must not overwrite a newer conversation choice.
    if (store.getState().currentSessionId !== id) return
    if (!session) {
      store.patch({ sessionLoading: false, runError: 'That conversation could not be opened.' })
      return
    }
    adoptSession(session)
  } catch (e) {
    if (store.getState().currentSessionId === id) {
      store.patch({ sessionLoading: false, runError: errText(e) })
    }
  }
}

/**
 * Open this bot's newest conversation, or start one when it has none.
 *
 * Sidebar navigation only. It does not change how a conversation is stored,
 * how a turn resumes, or what New chat (`newSession`) creates.
 */
export async function openBotChat(botId: string): Promise<void> {
  const existing = latestChatForBot(store.getState().sessions, botId)
  if (existing) {
    await selectSession(existing.id)
    return
  }
  await newSession([botId])
}

/**
 * Start a chat.
 *
 * When a project is selected the chat is filed into it — and inherits its
 * working folder and its bots — so "New chat" means "new chat in this project"
 * rather than silently creating a loose one the user then cannot find.
 */
export async function newSession(botIds?: string[]): Promise<void> {
  const { currentProjectId, projects } = store.getState()
  const project = currentProjectId ? projects.find((p) => p.id === currentProjectId) : undefined

  try {
    const session = await bridge().sessions.create(botIds)

    if (project) {
      const api = bridge().sessions as { setProject?: (id: string, projectId: string | null) => Promise<void> }
      // Optional on the bridge: an older preload simply leaves the chat loose.
      if (api.setProject) {
        await api.setProject(session.id, project.id)
        session.projectId = project.id
      }
      const full = await bridge().projects.get(project.id).catch(() => null)
      if (full?.cwd && full.cwd !== session.cwd) {
        await bridge().sessions.setCwd(session.id, full.cwd)
        session.cwd = full.cwd
      }
    }

    adoptSession(session)
    store.patch({ projectHome: null })
    store.setModal(null)
    await loadSessions()
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const clean = title.trim()
  if (!clean) return
  const { sessions, session } = store.getState()
  try {
    await bridge().sessions.rename(id, clean)
    store.patch({
      sessions: sessions.map((s) => (s.id === id ? { ...s, title: clean } : s)),
      session: session && session.id === id ? { ...session, title: clean } : session
    })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

/** Absent rather than undefined, so the state matches what the store writes back. */
function withProject<T extends { projectId?: string }>(value: T, projectId: string | null): T {
  const next = { ...value }
  if (projectId) next.projectId = projectId
  else delete next.projectId
  return next
}

/**
 * File an existing chat under a project, or pass null to unfile it.
 *
 * `sessions.setProject` has been on the bridge all along, but the only caller
 * was `openCardChat`, which files a chat it has just created. So filing was a
 * decision taken once, at birth, and never revisited: a loose chat could not be
 * moved into a project, a filed one could not be moved out, and neither could
 * cross between projects. This is the same call, reachable.
 *
 * Both halves of the UI are patched rather than left to the `session-updated`
 * broadcast: the row must leave the loose list on the click, and the sidebar's
 * per-project chat counts come from the project summaries, which only a reload
 * of those summaries refreshes.
 */
export async function setSessionProject(id: string, projectId: string | null): Promise<void> {
  const api = bridge().sessions as {
    setProject?: (id: string, projectId: string | null) => Promise<void>
  }
  // Optional on the bridge: an older preload has no way to move the chat, so
  // say so rather than move the row and let the next snapshot put it back.
  if (!api.setProject) {
    store.toast('This build cannot file a conversation into a project yet.', 'error')
    return
  }
  const current = store.getState().sessions.find((s) => s.id === id)
  if (!current || (current.projectId ?? null) === projectId) return

  try {
    await api.setProject(id, projectId)
    // Read after the round trip: a snapshot taken before it would discard
    // anything that landed while the call was in flight.
    const { sessions, session } = store.getState()
    store.patch({
      sessions: sessions.map((s) => (s.id === id ? withProject(s, projectId) : s)),
      session: session && session.id === id ? withProject(session, projectId) : session
    })
    await loadProjects()
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function toggleArchive(id: string): Promise<void> {
  const archived = store.getState().sessions.find((s) => s.id === id)?.archived === true
  try {
    const api = bridge().sessions
    if (archived) {
      // `archive` only ever archives. Restoring needs its own call, which older
      // preloads do not carry — say so rather than flip the row and let the
      // next snapshot silently put it back.
      const unarchive = (api as { unarchive?: (id: string) => Promise<void> }).unarchive
      if (!unarchive) {
        store.toast('This build cannot restore an archived conversation yet.', 'error')
        return
      }
      await unarchive(id)
    } else {
      await api.archive(id)
    }
    store.patch({
      sessions: store.getState().sessions.map((s) => (s.id === id ? { ...s, archived: !archived } : s))
    })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function removeSession(id: string): Promise<void> {
  try {
    await bridge().sessions.remove(id)
    const sessions = store.getState().sessions.filter((s) => s.id !== id)
    store.patch({ sessions })
    if (store.getState().currentSessionId !== id) return
    const next = sessions.find((s) => !s.archived)
    if (next) {
      store.patch({ currentSessionId: null })
      await selectSession(next.id)
    } else {
      store.resetMessages([])
      store.patch({ currentSessionId: null, session: null, messageIds: EMPTY_IDS, todos: EMPTY_TODOS })
    }
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function setMode(mode: AgentMode): Promise<void> {
  const session = store.getState().session
  if (!session) return
  store.patch({ session: { ...session, mode } })
  try {
    await bridge().sessions.setMode(session.id, mode)
  } catch (e) {
    store.patch({ session })
    store.toast(errText(e), 'error')
  }
}

/** Choose the folder this chat works in. */
export async function setSessionCwd(cwd: string): Promise<void> {
  const session = store.getState().session
  if (!session || !cwd || cwd === session.cwd) return
  try {
    await bridge().sessions.setCwd(session.id, cwd)
    store.patch({ session: { ...session, cwd } })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function addBotToSession(botId: string): Promise<void> {
  const session = store.getState().session
  if (!session || session.botIds.includes(botId)) return
  try {
    await bridge().sessions.addBot(session.id, botId)
    store.patch({ session: { ...session, botIds: [...session.botIds, botId] } })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function removeBotFromSession(botId: string): Promise<void> {
  const session = store.getState().session
  if (!session || session.botIds.length <= 1) return
  try {
    await bridge().sessions.removeBot(session.id, botId)
    store.patch({ session: { ...session, botIds: session.botIds.filter((b) => b !== botId) } })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}
