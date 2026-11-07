/**
 * Projects and their boards.
 *
 * Board calls all return the whole board, so the pattern here is: send the
 * mutation, adopt what comes back, refresh the summaries whose card counts the
 * sidebar shows. Only the drag is optimistic — a card must not hang mid-air
 * while a round trip completes.
 */

import type { Board, BoardCard, Project, ProjectTag } from '../../../shared/types'
import { insertionIndex, withCardMoved } from '../lib/board'
import { errText, tryBridge } from './bridge'
import { store } from './core'
import { reach, unavailable } from './projectsBridge'

export { openCardChat } from './cardChat'
export { projectsReady } from './projectsBridge'
export type { ProjectsBridge } from './projectsBridge'

const REFUSED = 'That change did not stick — the board has been reloaded.'

/* ── Projects ─────────────────────────────────────────────────────── */

export async function loadProjects(): Promise<void> {
  const list = reach('list')
  if (!list) {
    store.patch({ projects: [], projectsError: null })
    return
  }
  try {
    store.patch({ projects: await list(), projectsError: null })
  } catch (e) {
    store.patch({ projectsError: errText(e) })
  }
}

/** The full record behind a summary — the editor needs cwd and bot assignments. */
export async function fetchProject(id: string): Promise<Project | null> {
  const get = reach('get')
  if (!get) {
    unavailable()
    return null
  }
  try {
    return await get(id)
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

/** Selecting a project opens its home and narrows the conversation list. */
export function selectProject(id: string | null): void {
  store.patch({ currentProjectId: id, projectHome: id })
}

export function setProjectFilter(tag: ProjectTag | null): void {
  store.patch({ projectFilter: tag })
}

/** `new` opens an empty form, an id edits, null closes. */
export function openProjectEditor(draftId: string | null): void {
  store.patch({ modal: draftId ? 'project' : null, projectDraftId: draftId })
}

export async function createProject(partial: Partial<Project>): Promise<Project | null> {
  const create = reach('create')
  if (!create) {
    unavailable()
    return null
  }
  try {
    const project = await create(partial)
    await loadProjects()
    store.patch({ currentProjectId: project.id, projectHome: project.id })
    return project
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<Project | null> {
  const update = reach('update')
  if (!update) {
    unavailable()
    return null
  }
  try {
    const project = await update(id, patch)
    await loadProjects()
    return project
  } catch (e) {
    store.toast(errText(e), 'error')
    return null
  }
}

export async function removeProject(id: string): Promise<void> {
  const remove = reach('remove')
  if (!remove) return unavailable()
  try {
    await remove(id)
    // State is read *after* the round trip: anything that landed while it was in
    // flight would be lost if we patched a snapshot taken before it.
    const { currentProjectId, projectHome, board } = store.getState()
    const wasOpen = currentProjectId === id
    store.patch({
      currentProjectId: wasOpen ? null : currentProjectId,
      projectHome: projectHome === id ? null : projectHome,
      board: wasOpen ? null : board,
      projectDraftId: null,
      modal: null
    })
    await loadProjects()
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

/* ── Board ────────────────────────────────────────────────────────── */

export async function openBoard(projectId: string): Promise<void> {
  store.patch({ currentProjectId: projectId, projectHome: projectId, modal: 'board', board: null, boardLoading: true })
  await loadBoard(projectId)
}

/** Answers for a project the user has already navigated away from are dropped. */
const stillOpen = (projectId: string): boolean => store.getState().currentProjectId === projectId

export async function loadBoard(projectId: string): Promise<void> {
  const read = reach('board')
  if (!read) {
    store.patch({ boardLoading: false })
    unavailable()
    return
  }
  try {
    const board = await read(projectId)
    if (!stillOpen(projectId)) return
    store.patch({ board, boardLoading: false })
    // No board means the project is gone; the sidebar still lists it, so refresh.
    if (!board) await loadProjects()
  } catch (e) {
    if (stillOpen(projectId)) store.patch({ boardLoading: false })
    store.toast(errText(e), 'error')
  }
}

/**
 * Runs a board mutation against the open project and adopts the returned board.
 * `rollbackTo` is the board to put back when a change is refused — pass it
 * explicitly after an optimistic patch, or the board shown would be the guess
 * rather than the last known truth. A thrown failure reconciles by re-reading
 * instead, since the snapshot cannot say what else has happened since.
 */
async function mutate(run: (projectId: string) => Promise<Board | null>, rollbackTo?: Board | null): Promise<boolean> {
  const projectId = store.getState().currentProjectId
  if (!projectId) return false
  const previous = rollbackTo === undefined ? store.getState().board : rollbackTo
  try {
    const board = await run(projectId)
    if (!stillOpen(projectId)) return false
    if (!board) {
      // The board channels answer null instead of throwing, so a refused change
      // arrives here rather than in the catch. Put the last known truth back and
      // then re-read, or an optimistic drag would be left standing as fact.
      store.patch({ board: previous })
      store.toast(REFUSED, 'error')
      await loadBoard(projectId)
      return false
    }
    store.patch({ board })
    await loadProjects()
    return true
  } catch (e) {
    store.toast(errText(e), 'error')
    /*
     * Re-read rather than restore the snapshot. `previous` was taken before the
     * round trip, so putting it back discarded everything that landed while the
     * call was in flight — a card an agent added, a second drag — along with
     * the move that failed. Only the stored board can settle both, and the
     * optimistic patch stands for the moment it takes to fetch it.
     */
    if (stillOpen(projectId)) await loadBoard(projectId)
    return false
  }
}

export async function addCard(columnId: string, title: string): Promise<boolean> {
  const clean = title.trim()
  if (!clean) return false
  const add = reach('addCard')
  if (!add) { unavailable(); return false }
  return mutate((projectId) => add(projectId, columnId, { title: clean, notes: '' }))
}

export async function updateCard(cardId: string, patch: Partial<BoardCard>): Promise<boolean> {
  const update = reach('updateCard')
  if (!update) { unavailable(); return false }
  return mutate((projectId) => update(projectId, cardId, patch))
}

export async function removeCard(cardId: string): Promise<void> {
  const remove = reach('removeCard')
  if (!remove) return unavailable()
  await mutate((projectId) => remove(projectId, cardId))
}

/**
 * `visualIndex` is the slot the drop indicator sat in; the store wants the
 * index after the card is lifted out, so translate first and skip no-op moves.
 */
export async function moveCard(cardId: string, toColumnId: string, visualIndex: number): Promise<void> {
  const move = reach('moveCard')
  if (!move) return unavailable()
  const board = store.getState().board
  const toIndex = insertionIndex(board, cardId, toColumnId, visualIndex)
  if (toIndex === null || !board) return
  store.patch({ board: withCardMoved(board, cardId, toColumnId, toIndex) })
  await mutate((projectId) => move(projectId, cardId, toColumnId, toIndex), board)
}

export async function addColumn(name: string): Promise<boolean> {
  const clean = name.trim()
  if (!clean) return false
  const add = reach('addColumn')
  if (!add) { unavailable(); return false }
  return mutate((projectId) => add(projectId, clean))
}

export async function renameColumn(columnId: string, name: string): Promise<boolean> {
  const clean = name.trim()
  if (!clean) return false
  const rename = reach('renameColumn')
  if (!rename) { unavailable(); return false }
  return mutate((projectId) => rename(projectId, columnId, clean))
}

export async function removeColumn(columnId: string): Promise<void> {
  const remove = reach('removeColumn')
  if (!remove) return unavailable()
  await mutate((projectId) => remove(projectId, columnId))
}

/* ── The finished column ──────────────────────────────────────────── */

/**
 * True once the build can persist which column means "finished".
 *
 * Still asked rather than assumed: the board would rather leave the toggle out
 * than offer one that silently does nothing, and a renderer can outlive the
 * preload it was built against.
 */
export function columnDoneReady(): boolean {
  return reach('setColumnDone') !== null
}

export async function setColumnDone(columnId: string, done: boolean): Promise<void> {
  const mark = reach('setColumnDone')
  if (!mark) return unavailable()
  await mutate((projectId) => mark(projectId, columnId, done))
}
