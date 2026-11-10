import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { store, useAppState } from '../state'
import type { ToastUi } from '../state'
import { IconClose, IconWarning } from './Icons'
import './Toast.css'

/** A transient status occupies its own row, never the composer's hit area. */
export function Toast(): ReactNode {
  const { toast, settings } = useAppState()
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  const visible = Boolean(toast)

  useLayoutEffect(() => {
    if (!visible) { setSurface(null); return }
    const root = document.querySelector('.ob-app')
    if (!root) return
    const place = (): void => {
      const dialogs = root.querySelectorAll<HTMLElement>('.ob-modal')
      setSurface(dialogs.item(dialogs.length - 1) ?? root.querySelector<HTMLElement>('.ob-main'))
    }
    place()
    // Nested editors can open without changing App's modal name. Follow only
    // dialog changes, rather than moving the status for every streamed token.
    const observer = new MutationObserver((changes) => {
      if (changes.some(({ addedNodes, removedNodes }) => [...addedNodes, ...removedNodes].some((node) =>
        node instanceof Element && (node.matches('.ob-modal') || node.querySelector('.ob-modal'))
      ))) place()
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [visible])

  return toast && surface ? createPortal(<ToastMessage toast={toast} zh={settings?.language === 'zh-CN'} />, surface) : null
}

function ToastMessage({ toast, zh }: { toast: ToastUi; zh: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const first = toast.text.split(/\r?\n/).find(line => line.trim())?.trim() ?? toast.text
  const summary = first.length > 140 ? first.slice(0, 140) + '…' : first
  useLayoutEffect(() => {
    let previous = document.activeElement
    const notice = ref.current
    const rememberFocus = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && !notice?.contains(event.target)) previous = event.target
    }
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('focusin', rememberFocus)
      if (notice?.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return (
    <div ref={ref} className={`ob-toast ob-toast-${toast.kind}`} role="status" aria-live="polite" aria-atomic="true">
      {toast.kind === 'error' ? <IconWarning size={13} /> : null}
      <div className="ob-toast-copy"><span className="ob-toast-text" tabIndex={0}>{summary}</span>
        {summary !== toast.text ? <details className="ob-toast-detail"><summary>{zh ? '查看详情' : 'View details'}</summary><div className="ob-toast-text" tabIndex={0}>{toast.text}</div></details> : null}
      </div>
      <button type="button" className="ob-icon-btn" aria-label={zh ? '关闭提示' : 'Dismiss message'} onClick={() => store.dismissToast()}>
        <IconClose size={11} />
      </button>
    </div>
  )
}
