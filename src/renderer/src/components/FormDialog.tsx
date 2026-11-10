import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Modal } from './Modal'
import { captureReturnFocus, restoreReturnFocus } from './returnFocus'

/** A form opened over a manager returns to its own trigger, even when the
 * enclosing dialog remains open. Capture before Modal's focus effect runs. */
export function FormDialog({ fallbackFocus, ...props }: ComponentProps<typeof Modal> & { fallbackFocus?: string }): ReactNode {
  const [returnTo] = useState(captureReturnFocus)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // A disabled submit button or a replaced list row can leave focus on body.
    // Keep Escape with this form in that case, without pre-empting a focused
    // child's own Escape handling (avatar menus, delete confirmation, etc.).
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.repeat || event.isComposing || event.defaultPrevented) return
      const panel = root.current?.querySelector('.ob-modal')
      if (!panel) return
      const target = event.target instanceof Element ? event.target : null
      if (panel.contains(event.target as Node) && !target?.closest('.ob-toast')) return
      const focusedDialog = target?.closest('[role="dialog"][aria-modal="true"]')
      if (focusedDialog && focusedDialog !== panel) return
      if ([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) !== panel) return
      event.preventDefault(); event.stopPropagation()
      ;(props.onEscape ?? props.onClose)()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [props.onClose, props.onEscape])
  useEffect(() => () => {
    const fallback = fallbackFocus ? document.querySelector<HTMLElement>(fallbackFocus) : null
    const owner = fallback?.closest('[role="dialog"]')
    const target = fallback && (!returnTo || !returnTo.element.isConnected || (owner && !owner.contains(returnTo.element)))
      ? { element: fallback, keyboard: returnTo?.keyboard ?? true } : returnTo
    restoreReturnFocus(target)
  }, [returnTo, fallbackFocus])
  return <div ref={root} style={{ display: 'contents' }}><Modal {...props} /></div>
}
