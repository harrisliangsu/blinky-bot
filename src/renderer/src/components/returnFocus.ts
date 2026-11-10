/** Return focus for Bot drawers and connection subdialogs, which do not own
 * the app-wide modal trap's final return target. */
import { useEffect } from 'react'

export interface ReturnFocus {
  element: HTMLElement
  keyboard: boolean
}

export function captureReturnFocus(): ReturnFocus | null {
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || element === document.body) return null
  return { element, keyboard: document.documentElement.dataset.obInputMode !== 'pointer' && element.matches(':focus-visible') }
}

export function restoreReturnFocus(target: ReturnFocus | null): void {
  // Let the closing component unmount and the enclosing modal finish its own
  // cleanup first. A newly opened modal must retain keyboard ownership.
  requestAnimationFrame(() => {
    if (!target?.element.isConnected) return
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    const owner = dialogs.at(-1)
    if (owner && !owner.contains(target.element)) return
    const element = target.element
    if (!target.keyboard) {
      element.setAttribute('data-ob-pointer-focus-restored', '')
      const clear = (): void => {
        element.removeAttribute('data-ob-pointer-focus-restored')
        document.removeEventListener('keydown', clear, true)
        element.removeEventListener('blur', clear)
      }
      document.addEventListener('keydown', clear, true)
      element.addEventListener('blur', clear, { once: true })
    }
    element.focus({ preventScroll: true })
  })
}

export function useReturnFocus(enabled = true, fallbackSelector?: string): void {
  useEffect(() => {
    if (!enabled) return
    let target = captureReturnFocus()
    // A drawer can be opened directly from the Sidebar while its containing
    // Bot manager mounts. Returning outside that still-open modal would leave
    // keyboard focus behind the scrim, so use the matching gallery card.
    const fallback = fallbackSelector ? document.querySelector<HTMLElement>(fallbackSelector) : null
    const dialog = fallback?.closest('[role="dialog"]')
    if (target && fallback && dialog && !dialog.contains(target.element)) target = { ...target, element: fallback }
    return () => restoreReturnFocus(target)
  }, [enabled, fallbackSelector])
}
