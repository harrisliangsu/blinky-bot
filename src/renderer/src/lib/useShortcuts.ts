import { useEffect, useRef } from 'react'
import { isEditableTarget, store, stopTurn, useAppState } from '../state'
import { onMenuCommand } from './menu'
import { shortcutFor } from './shortcutRules'

/**
 * The palette hands Escape to the app to close itself. The composer does not:
 * clearing a suggestion must never stop the user's active task.
 */
const PASSES_ESCAPE = '.ob-palette-input'

function passesEscape(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest(PASSES_ESCAPE) !== null
}

/** Global keyboard and native menu commands. */
export function useShortcuts(botDetailsOpen = false, closeBotDetails?: () => void): void {
  const state = useAppState()
  const latest = useRef(state)
  latest.current = state
  const details = useRef({ botDetailsOpen, closeBotDetails })
  details.current = { botDetailsOpen, closeBotDetails }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const { approvals, modal, streaming } = latest.current
      if (e.key === 'Escape' && !e.repeat && !e.isComposing && !modal && details.current.botDetailsOpen) {
        e.preventDefault()
        details.current.closeBotDetails?.()
        return
      }
      if ((e.metaKey || (e.ctrlKey && !isEditableTarget(e.target))) && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing && !modal) {
        const key = e.key.toLowerCase()
        if (key === 'l' || key === 'f') {
          e.preventDefault()
          if (key === 'l') document.querySelector<HTMLTextAreaElement>('#ob-prompt')?.focus()
          else window.dispatchEvent(new Event('openbot:focus-bot-search'))
          return
        }
      }
      // Read once and pass it on: the rules need the same answer for Escape as
      // for Ctrl, and asking the DOM twice invites the two to drift apart.
      const editable = isEditableTarget(e.target)
      const action = shortcutFor(
        {
          key: e.key,
          // Ctrl+K is macOS caret movement inside a text field. Claiming
          // it there would open the palette instead of moving the cursor, so
          // while the user is typing only the Command key counts.
          mod: e.metaKey || (e.ctrlKey && !editable),
          alt: e.altKey,
          shift: e.shiftKey,
          composing: e.isComposing,
          repeat: e.repeat,
          editable,
          passesEscape: editable && passesEscape(e.target)
        },
        { approvals: approvals.length, modalOpen: modal !== null, paletteOpen: modal === 'palette', streaming }
      )
      if (action === null) return
      e.preventDefault()

      if (action === 'toggle-palette') store.setModal(modal === 'palette' ? null : 'palette')
      else if (action === 'settings') store.setModal('settings')
      else if (action === 'toggle-sidebar') window.dispatchEvent(new Event('openbot:toggle-sidebar'))
      else if (action === 'close-modal') store.setModal(null)
      else if (action === 'stop-turn') void stopTurn()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(
    () =>
      onMenuCommand((command) => {
        if (command === 'settings' && !latest.current.modal) store.setModal('settings')
        if (!latest.current.modal && command === 'toggle-sidebar') window.dispatchEvent(new Event('openbot:toggle-sidebar'))
        if (!latest.current.modal && command === 'focus-composer') document.querySelector<HTMLTextAreaElement>('#ob-prompt')?.focus()
        if (!latest.current.modal && command === 'find-bot') window.dispatchEvent(new Event('openbot:focus-bot-search'))
      }),
    []
  )
}
