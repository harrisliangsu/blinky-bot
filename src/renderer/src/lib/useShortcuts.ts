import { useEffect, useRef } from 'react'
import { archiveAndClearChat, clearChat, isEditableTarget, respondToApproval, store, stopTurn, useAppState } from '../state'
import { onMenuCommand } from './menu'
import { shortcutFor } from './shortcutRules'

/**
 * The two text fields that hand Escape on to the app.
 *
 * Every other one swallows it, so a draft survives the keypress (see
 * `shortcutRules`). These two carry no draft and would each lose something real:
 *
 *  - the composer promises "Running — Esc to stop" in its own placeholder, and
 *    has no Escape handler of its own — its `onKeyDown` claims Enter and defers
 *    to the @ picker, nothing more.
 *  - the command palette autofocuses this input on open and traps Tab inside
 *    itself, and has no close button. Swallowing Escape there would leave a
 *    keyboard user with no way out of it at all.
 */
const PASSES_ESCAPE = '.ob-composer-input, .ob-palette-input'

function passesEscape(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest(PASSES_ESCAPE) !== null
}

/**
 * Global keys: Cmd/Ctrl+N clears the open chat, Cmd+K switcher, Cmd+, settings,
 * Esc rejects a pending approval, else closes a modal, else stops the run.
 * Native menu commands land on the same handlers.
 *
 * The decision lives in `shortcutRules` so a pending approval provably wins over
 * everything else; this hook only carries it out.
 */
export function useShortcuts(): void {
  const state = useAppState()
  const latest = useRef(state)
  latest.current = state

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const { approvals, modal, streaming } = latest.current
      // Read once and pass it on: the rules need the same answer for Escape as
      // for Ctrl, and asking the DOM twice invites the two to drift apart.
      const editable = isEditableTarget(e.target)
      const action = shortcutFor(
        {
          key: e.key,
          // Ctrl+N/Ctrl+K are macOS caret movement inside a text field. Claiming
          // them there would open a new chat instead of moving the cursor, so
          // while the user is typing only the Command key counts.
          mod: e.metaKey || (e.ctrlKey && !editable),
          alt: e.altKey,
          repeat: e.repeat,
          editable,
          passesEscape: editable && passesEscape(e.target)
        },
        { approvals: approvals.length, modalOpen: modal !== null, streaming }
      )
      if (action === null) return
      e.preventDefault()

      if (action === 'new-chat') void clearChat()
      else if (action === 'toggle-palette') store.setModal(modal === 'palette' ? null : 'palette')
      else if (action === 'settings') store.setModal('settings')
      else if (action === 'reject-approval') void respondToApproval(approvals[0].id, 'reject')
      else if (action === 'close-modal') store.setModal(null)
      else if (action === 'stop-turn') void stopTurn()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(
    () =>
      onMenuCommand((command) => {
        /*
         * The same gate as the keyboard, and not a duplicate of it: Cmd+N and
         * Cmd+, are registered as native accelerators, so in a packaged app they
         * are consumed by the menu and never reach the keydown handler above.
         * Guarding only that handler would have left both shortcuts working
         * straight through a pending approval.
         */
        if (latest.current.approvals.length > 0) return
        if (command === 'new-chat') void clearChat()
        if (command === 'archive-clear') void archiveAndClearChat()
        if (command === 'settings') store.setModal('settings')
      }),
    []
  )
}
