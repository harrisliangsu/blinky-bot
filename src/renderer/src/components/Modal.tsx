import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useFocusTrap } from '../lib/focusTrap'
import { IconClose } from './Icons'
import './Modal.css'

interface ModalProps {
  title: string
  subtitle?: string
  onClose: () => void
  /** Override Escape when a drawer inside the dialog must close first. */
  onEscape?: () => void
  /** Rendered on the right of the header — usually a primary action. */
  actions?: ReactNode
  /** `xl` is the full-height working surface — the board uses it. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children: ReactNode
}

/**
 * Dialog shell: click-outside and the close button dismiss it, Tab is trapped
 * inside, and focus returns to whatever opened it. Escape belongs to the
 * focused dialog, including when focus is inside an editable control.
 */
export function Modal({ title, subtitle, onClose, onEscape, actions, size = 'md', children }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  /*
   * The trap first, then the focus — effects run in the order they are written.
   * The trap notes where focus was so it can put it back when the dialog closes,
   * and focusing the panel before it ran made the panel itself that memory: a
   * node about to be unmounted, so closing the dialog restored nothing and left
   * focus on the body.
   */
  useFocusTrap(panelRef)

  /*
   * The panel, never the first control: that is usually the header's primary
   * action, so Cmd+K → "Bots" → Enter opened a dialog and immediately created
   * a new bot with the same keystroke.
   */
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <div className="ob-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`ob-modal ob-modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          ;(onEscape ?? onClose)()
        }}
      >
        <header className="ob-modal-head">
          <div className="ob-modal-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="ob-modal-actions">
            {actions}
            <button type="button" className="ob-icon-btn" onClick={onClose} aria-label="Close dialog">
              <IconClose />
            </button>
          </div>
        </header>
        <div className="ob-modal-body">{children}</div>
      </div>
    </div>
  )
}
