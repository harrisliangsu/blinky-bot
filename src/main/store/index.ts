/**
 * Store entry point: one call to bring persistence up, one to flush it down.
 * Other main-process modules import the typed CRUD from here.
 */

import { adoptReadyDefaultBackend } from '../backends/adoptDefault'
import { initSettings } from '../settings'
import { flushAll, type FlushReport } from './jsonStore'
import { ensureAllDirs } from './paths'
import { loadBots, seedBotsIfEmpty } from './bots'
import { loadMemory } from './memory'
import { getProject, loadProjects, projectsLoadWasIncomplete } from './projects'
import { loadRoutines } from './routines'
import { loadSessions, unfileOrphanedSessions } from './sessions'
import { loadVmSecrets } from './vmSecrets'
import { loadBackendSecrets } from './backendSecrets'
import { loadMcpSecrets } from './mcpSecrets'
import { loadActivity } from './activity'
import { loadTasks } from './tasks'
import { loadGroups } from './groups'
import { loadRooms } from './rooms'

/**
 * Create the data directories, load settings, then load every collection.
 * Settings come first because bot seeding reads the default backend/model.
 */
export async function initStore(): Promise<void> {
  ensureAllDirs()
  await loadBackendSecrets()
  await loadMcpSecrets()
  await initSettings()
  // Bot documents may contain legacy plaintext VM tokens that are migrated
  // while bots load, so the encrypted destination must be ready first.
  await loadVmSecrets()
  await Promise.all([
    loadBots(),
    loadSessions(),
    loadProjects(),
    loadRoutines(),
    loadMemory(),
    loadActivity(),
    loadTasks(),
    loadGroups(),
    loadRooms()
  ])
  /*
   * Starter bots copy `defaultBackendId`. Choose a signed-in CLI first, and
   * move bots that are still on an unavailable factory default, so a 0.2
   * profile that only has Codex or Claude Code does not keep spawning
   * `opencode`.
   */
  try {
    await adoptReadyDefaultBackend()
  } catch (error) {
    console.warn('[openbot/store] could not choose a default backend', error)
  }
  seedBotsIfEmpty()
  /*
   * Both collections are loaded here, which is what this needs and what makes
   * it wrong inside `loadProjects` — the sessions may not have arrived yet.
   *
   * Skipped entirely when any project file failed to read. The cascade decides
   * a project is *deleted* from its absence, and then strips `projectId` from
   * every chat that pointed at it — so one unreadable file, or a directory
   * temporarily denied at startup, silently unfiled a whole project's chats
   * with no way back. A chat filed under a project that really is gone is
   * merely hidden until the next clean start; this is not.
   */
  if (projectsLoadWasIncomplete()) {
    console.warn('[openbot/store] some projects could not be read — leaving chat filing untouched')
    return
  }
  const rescued = unfileOrphanedSessions((id) => getProject(id) !== null)
  if (rescued.length > 0) {
    console.warn('[openbot/store] unfiled', rescued.length, 'chat(s) from deleted projects')
  }
}

/**
 * Flush every pending debounced write. Call before quitting.
 *
 * The report has to be looked at. Write failures were swallowed all the way
 * down, so this resolved cleanly while every write had failed and the user's
 * last messages existed only in memory.
 */
export async function flushStore(): Promise<FlushReport> {
  return await flushAll()
}

// Explicit re-exports: the domain modules also carry short conventional
// aliases (`save`, `list`, `add`) which would collide in a star export.
export {
  loadBots,
  listBots,
  getBot,
  defaultBotId,
  createBot,
  duplicateBot,
  updateBot,
  removeBot,
  seedBotsIfEmpty
} from './bots'

export {
  loadMemory,
  listBotMemory,
  addBotMemory,
  removeBotMemory,
  clearBotMemory
} from './memory'

export {
  loadProjects,
  projectsLoadWasIncomplete,
  listProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
  removeBotFromProjects,
  getBoard,
  addCard,
  updateCard,
  moveCard,
  removeCard,
  addColumn,
  renameColumn,
  removeColumn
} from './projects'

export { projectSummaries } from './projectSummaries'

export {
  loadRoutines,
  listRoutines,
  getRoutine,
  saveRoutine,
  createRoutine,
  updateRoutine,
  markRoutineRun,
  removeRoutine,
  removeRoutinesForBot
} from './routines'

export {
  loadSessions,
  listSessions,
  getSession,
  allSessions,
  saveSession,
  createSession,
  renameSession,
  archiveSession,
  unarchiveSession,
  removeSession,
  setSessionMode,
  setSessionCwd,
  setSessionProject,
  addBotToSession,
  removeBotFromSession,
  removeBotFromAllSessions,
  setActiveBot,
  appendMessage,
  updateMessage,
  removeMessage,
  setTodos,
  updateSession
} from './sessions'

export type { FlushReport } from './jsonStore'
export { flushAll } from './jsonStore'
export { dataRoot } from './paths'
