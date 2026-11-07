/** Keyboard ownership for modal UI and the chat composer. Approvals are inline. */

/** What a global key press means. `null` is "not ours — leave it alone". */
export type ShortcutAction =
  | 'toggle-palette'
  | 'settings'
  | 'toggle-sidebar'
  | 'close-modal'
  | 'stop-turn'
  | null

/** The parts of a key event the rules depend on. */
export interface KeyIntent {
  key: string
  /** Command, or Control when the target is not a text field. */
  mod: boolean
  alt: boolean
  shift?: boolean
  composing?: boolean
  /** A held key: Escape must answer one gate per press, not walk the queue. */
  repeat: boolean
  /** The press came from a text field — an input, textarea or contenteditable. */
  editable: boolean
  /** Whether this editable field passes Escape to the app. */
  passesEscape: boolean
}

/** The parts of the app the rules depend on. */
export interface ShellState {
  /** Approval gates waiting to be answered. */
  approvals: number
  /** Any dialog is open — Settings, Bots, the palette, the board. */
  modalOpen: boolean
  paletteOpen?: boolean
  streaming: boolean
}

/** Modal surfaces, but not inline approvals, own navigation shortcuts. */
export function overlayOwnsKeys(state: { approvals: number; modalOpen: boolean }): boolean {
  return state.modalOpen
}

/** Resolve an app-level shortcut without stealing input from editable fields. */
export function shortcutFor(intent: KeyIntent, state: ShellState): ShortcutAction {
  if (intent.composing) return null
  if (intent.mod && !intent.alt && !intent.shift && !intent.repeat) {
    const key = intent.key.toLowerCase()
    if (key === 'k' && (!state.modalOpen || state.paletteOpen)) return 'toggle-palette'
    if (key === ',' && !state.modalOpen) return 'settings'
    if (key === '\\' && !state.modalOpen) return 'toggle-sidebar'
  }

  if (intent.key !== 'Escape' || intent.repeat) return null

  /*
   * Escape inside a text field belongs to the field, not to the app.
   *
   * Only `mod` used to consult the target, so Escape was claimed wherever it was
   * pressed — and the components that do not stop it themselves (BotEditor,
   * ProjectEditor, CardEditor, the settings panels, BotMemory, TagInput,
   * RoutinePanel, Sidebar) each paid for it twice over. Pressing Escape in a
   * long system prompt, the reflex for dismissing an autocomplete, matched
   * `close-modal` and unmounted the editor with the unsaved draft inside it.
   * Pressing it to clear the sidebar search box while a turn ran matched
   * `stop-turn` one branch further down and killed the agent. ModelPicker
   * documents this same bug and works around it locally, for itself only.
   *
   * `passesEscape` is how the two fields that WANT the app's Escape say so —
   * see `KeyIntent`. Without it this guard would have taken the composer's
   * advertised "Esc to stop" away, and shut the only keyboard exit from the
   * command palette.
   */
  if (intent.editable && !intent.passesEscape) return null

  if (state.modalOpen) return 'close-modal'
  if (state.streaming) return 'stop-turn'
  return null
}
