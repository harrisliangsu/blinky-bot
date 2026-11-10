/**
 * The multi-pane workspace: which conversations tile side by side, in which
 * layout, and which pane has focus.
 *
 * Exactly one pane is focused, and the focused pane's chat IS the app's current
 * session — focusing a pane calls `selectSession`. That keeps a single source of
 * truth for the message registry and the live event stream: the app never tries
 * to stream into four panes at once, and the composer always writes to the pane
 * the user is looking at. Unfocused panes render a snapshot of their session
 * (see `PaneChat`), which is why the same chat may sit in two panes harmlessly.
 */

import type { Session } from '../../../shared/types'
import { DEFAULT_PRESET, fitPanes, isLayoutPreset, type LayoutPreset } from '../lib/paneLayout'
import { overlayOwnsKeys } from '../lib/shortcutRules'
import { bridge } from './bridge'
import { store } from './core'
import { openBotChat, selectSession } from './sessions'
import type { WorkspaceUi } from './types'

/** Renderer-local UI preference; deliberately not main-process settings. */
const STORAGE_KEY = 'openbot.workspace.preset'

export function loadPreset(): LayoutPreset {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isLayoutPreset(stored) ? stored : DEFAULT_PRESET
  } catch {
    return DEFAULT_PRESET
  }
}

function savePreset(preset: LayoutPreset): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preset)
  } catch {
    /* Storage denied: the choice simply resets next launch. */
  }
}

function current(): WorkspaceUi {
  return store.getState().workspace
}

function patch(next: Partial<WorkspaceUi>): void {
  store.patch({ workspace: { ...current(), ...next } })
}

/** Focus follows the pane: its chat becomes the one the app is streaming. */
function follow(sessionId: string | null): void {
  if (!sessionId || store.getState().currentSessionId === sessionId) return
  void selectSession(sessionId)
}

/** First pane holding a chat, or 0 when the workspace is empty. */
function firstFilled(panes: readonly (string | null)[]): number {
  const index = panes.findIndex((id) => id !== null)
  return index < 0 ? 0 : index
}

export function openWorkspace(): void {
  const state = store.getState()
  if (state.workspace.open) { if (state.projectHome) store.patch({ projectHome: null }); return }
  const preset = loadPreset()
  const panes = fitPanes(state.workspace.panes, preset)
  // Opening from a conversation carries it into the first pane, so the
  // workspace starts where the user already was rather than blank.
  if (!panes.some((id) => id !== null) && state.currentSessionId) panes[0] = state.currentSessionId
  store.patch({ projectHome: null, workspace: { open: true, preset, panes, focused: firstFilled(panes) } })
}

/** Leaves the pane assignments intact, so reopening restores the arrangement. */
export function closeWorkspace(): void {
  patch({ open: false })
}

export function toggleWorkspace(): void {
  if (current().open && !store.getState().projectHome) closeWorkspace()
  else openWorkspace()
}

export function setPreset(preset: LayoutPreset): void {
  const ws = current()
  const panes = fitPanes(ws.panes, preset)
  // Shrinking can drop the focused pane; land on a chat rather than an empty
  // slot, so the live conversation keeps a pane to stream into.
  const clamped = Math.min(ws.focused, panes.length - 1)
  const focused = panes[clamped] === null ? firstFilled(panes) : clamped
  patch({ preset, panes, focused })
  savePreset(preset)
  follow(panes[focused])
}

/** Puts a chat in a slot and focuses it — picking a chat means working in it. */
export function assignPane(index: number, sessionId: string): void {
  const ws = current()
  if (index < 0 || index >= ws.panes.length) return
  const panes = ws.panes.slice()
  panes[index] = sessionId
  patch({ panes, focused: index })
  follow(sessionId)
}

export function clearPane(index: number): void {
  const ws = current()
  if (index < 0 || index >= ws.panes.length) return
  const panes = ws.panes.slice()
  panes[index] = null
  // Focus never rests on an emptied pane while another chat is still open.
  const focused = ws.focused === index ? firstFilled(panes) : ws.focused
  patch({ panes, focused })
  follow(panes[focused])
}

export function focusPane(index: number): void {
  const ws = current()
  if (index < 0 || index >= ws.panes.length) return
  if (index !== ws.focused) patch({ focused: index })
  // Re-follow even when the index is unchanged: the app's current session can
  // have moved on (sidebar navigation, a deleted chat) while this pane stayed.
  follow(ws.panes[index])
}

export function closeFocusedPane(): void {
  clearPane(current().focused)
}

/**
 * Keyboard focus travel between panes; wraps at both ends. Empty slots are
 * skipped — focus decides which chat is live, and an empty slot has none, so
 * landing on one would leave the running chat rendering as a snapshot.
 */
export function moveFocus(delta: number): void {
  const ws = current()
  const count = ws.panes.length
  if (count < 2) return
  const step = delta < 0 ? -1 : 1
  for (let i = 1; i <= count; i += 1) {
    const at = (((ws.focused + step * i) % count) + count) % count
    if (ws.panes[at] !== null) {
      focusPane(at)
      return
    }
  }
}

/**
 * A read-only copy of a chat for an unfocused pane. The message registry only
 * ever holds the CURRENT session, so a pane that is not focused cannot read its
 * messages from the store — it has to fetch its own snapshot. Null means the
 * conversation no longer exists.
 */
export async function fetchPaneSession(id: string): Promise<Session | null> {
  return await bridge().sessions.get(id)
}

/** Starts a fresh chat directly in a slot. */
export async function startPaneChat(index: number): Promise<void> {
  const botId = store.getState().bots.find((bot) => !bot.archived)?.id
  if (!botId) return
  await openBotChat(botId)
  const id = store.getState().currentSessionId
  if (id) assignPane(index, id)
}

/**
 * True when a key event is destined for a text field. Workspace shortcuts all
 * use Alt, which still types characters and moves the caret inside an editor,
 * so they must stand down while the user is writing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null
}

/**
 * Alt+G toggles the workspace from anywhere. It is registered once, at module
 * load, because the workspace has no chrome of its own while it is closed —
 * there is nothing mounted to own the shortcut.
 */
let hotkeyInstalled = false

export function installWorkspaceHotkey(): void {
  if (hotkeyInstalled || typeof window === 'undefined') return
  hotkeyInstalled = true
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return
    // On macOS Alt+G types "©", so the physical key is the reliable test.
    if (e.code !== 'KeyG' && e.key.toLowerCase() !== 'g') return
    if (isEditableTarget(e.target)) return
    // Retiling the app underneath an approval or an open dialog is the same
    // class of bug as Alt+arrow changing the live chat: the overlay asked a
    // question, and nothing may move until it is answered.
    const { approvals, modal } = store.getState()
    if (overlayOwnsKeys({ approvals: approvals.length, modalOpen: modal !== null })) return
    e.preventDefault()
    toggleWorkspace()
  })
}

installWorkspaceHotkey()
