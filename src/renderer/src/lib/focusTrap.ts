/**
 * Keep Tab inside the dialog that owns the screen, and give focus back when it
 * closes.
 *
 * Without a trap, focus walks straight out of the panel and into the app behind
 * the scrim: the user keeps typing into a composer they cannot see, and on an
 * approval card the buttons they are being asked about are no longer the ones
 * their keyboard is on.
 *
 * Traps are registered in a module-level stack because two dialogs really can
 * be open at once — an approval arrives while Settings is open, or the user
 * hits a shortcut behind an approval. Every trap listens on `document`, so
 * without the stack *both* handlers ran for one Tab: each saw focus in the
 * other panel, each pulled it back, and focus stuck to a single control with
 * the browser's own move never happening. Only the top of the stack acts.
 *
 * Only for genuinely modal surfaces. An inline disclosure — an expandable tool
 * call, an accordion — must NOT trap: the content is part of the page, and
 * trapping there strands keyboard users on a region they cannot leave.
 */

import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * How a dialog ranks when two are open. The approval gate is always on top —
 * it is blocking, and it is the one whose buttons must stay under the keyboard.
 */
export type TrapLevel = 'dialog' | 'blocking'

interface Entry {
  panel: RefObject<HTMLElement | null>
  level: TrapLevel
}

const stack: Entry[] = []

/** Where focus goes when the last dialog closes. */
let returnTo: HTMLElement | null = null
let returnToWasKeyboardFocus = false
let keyboardInput = true

// Record the way a dialog was opened before it moves focus into its panel.
// Escape itself must not turn a mouse-opened trigger into keyboard focus.
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { keyboardInput = false; document.documentElement.dataset.obInputMode = 'pointer' }, true)
  document.addEventListener('keydown', (event) => {
    // Escape closes a pointer-opened popover; it should not introduce a focus
    // ring onto its trigger. Tab and other keyboard use restore visible focus.
    if (event.key === 'Escape') return
    keyboardInput = true
    document.documentElement.dataset.obInputMode = 'keyboard'
  }, true)
}

/**
 * Which open dialog owns the keyboard: the most recent blocking one, or the
 * most recent of any kind when none is blocking.
 *
 * Order of opening is not enough on its own — pressing a shortcut behind an
 * approval mounts the other dialog *second*, and letting that win would drag
 * focus to a control behind the scrim, which is the escape the trap exists to
 * prevent.
 */
export function topIndex(levels: readonly TrapLevel[]): number {
  const blocking = levels.lastIndexOf('blocking')
  return blocking >= 0 ? blocking : levels.length - 1
}

function top(): Entry | undefined {
  return stack[topIndex(stack.map((entry) => entry.level))]
}

function activeElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/** Tabbable descendants, in DOM order, skipping anything not rendered. */
function tabbable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
}

/** Which end to wrap to, or `null` to let the browser move focus normally. */
export type WrapTarget = 'first' | 'last' | null

/**
 * The trap's whole decision, as a pure function.
 *
 * `activeIndex` is the position of the focused element among the panel's
 * tabbable nodes, or `-1` when focus is anywhere else — including on the panel
 * itself, which dialogs focus on open so a stray Enter cannot hit a button.
 * From outside, Tab must pull focus back in rather than continue from wherever
 * the page left off, which is the case that let focus escape behind the scrim.
 */
export function wrapTarget(count: number, activeIndex: number, shiftKey: boolean): WrapTarget {
  if (count === 0) return null
  if (activeIndex < 0) return shiftKey ? 'last' : 'first'
  if (shiftKey && activeIndex === 0) return 'last'
  if (!shiftKey && activeIndex === count - 1) return 'first'
  return null
}

export function useFocusTrap(panelRef: RefObject<HTMLElement | null>, level: TrapLevel = 'dialog'): void {
  useEffect(() => {
    const entry: Entry = { panel: panelRef, level }
    // Captured before the dialog steals focus, and only for the first one open:
    // a second dialog would otherwise "restore" to the first dialog's panel.
    if (stack.length === 0 && !returnTo) {
      returnTo = activeElement()
      returnToWasKeyboardFocus = keyboardInput && (returnTo?.matches(':focus-visible') ?? false)
    }
    stack.push(entry)

    const onKeyDown = (e: KeyboardEvent): void => {
      const panel = panelRef.current
      if (e.key !== 'Tab' || !panel || top() !== entry) return

      const nodes = tabbable(panel)
      const active = document.activeElement
      const target = wrapTarget(
        nodes.length,
        active instanceof HTMLElement ? nodes.indexOf(active) : -1,
        e.shiftKey
      )
      if (!target) return

      e.preventDefault()
      ;(target === 'first' ? nodes[0] : nodes[nodes.length - 1])?.focus()
    }

    // Capture phase: a child that stops propagation must not escape the trap.
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const at = stack.indexOf(entry)
      if (at >= 0) stack.splice(at, 1)
      if (stack.length > 0) return

      /*
       * Deferred, because a queue of approvals unmounts one dialog and mounts
       * the next in the same commit. Restoring immediately would throw focus
       * back to the composer between two cards.
       */
      queueMicrotask(() => {
        if (stack.length > 0) return
        const target = returnTo
        returnTo = null
        if (!target?.isConnected) return
        if (!returnToWasKeyboardFocus) {
          target.setAttribute('data-ob-pointer-focus-restored', '')
          const clear = (): void => {
            target.removeAttribute('data-ob-pointer-focus-restored')
            document.removeEventListener('keydown', clear, true)
            target.removeEventListener('blur', clear)
          }
          document.addEventListener('keydown', clear, true)
          target.addEventListener('blur', clear, { once: true })
        }
        target.focus()
      })
    }
  }, [panelRef, level])
}
