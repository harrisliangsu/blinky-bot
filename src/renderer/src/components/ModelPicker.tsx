import { useEffect, useRef, useState, type ReactNode } from 'react'
import { listedBackends } from '../../../shared/backendSections'
import { KNOWN_BACKEND_LABELS } from '../../../shared/backends'
import type { BackendInfo } from '../../../shared/types'
import { useAppState } from '../state'
import { IconChevronDown, IconRefresh, IconSpinner, IconWarning } from './Icons'
import { BackendMenu, STATUS_TONE } from './ModelPickerBackends'
import { ModelMenu } from './ModelPickerModels'
import './ModelPicker.css'

interface ModelPickerProps {
  backends: BackendInfo[]
  backendId: string
  modelId: string
  onSelect: (backendId: string, modelId: string) => void
  onRefresh: () => void
  loading?: boolean
  error?: string | null
  /** Opens above the trigger — used in the composer. */
  dropUp?: boolean
  disabled?: boolean
}

interface Flyout {
  backend: BackendInfo
  top: number
}

/** What Escape closes next; `pass` hands the key on to the app. */
export type EscapeStep = 'flyout' | 'menu' | 'pass'

/**
 * Escape peels one layer at a time.
 *
 * `pass` matters as much as the rest: while the menu is open the key must never
 * reach the global handler. In the bot editor that handler saw an open modal and
 * closed it, so dismissing this dropdown threw away an unsaved system prompt; in
 * the composer it stopped the running turn instead.
 */
export function escapeStep(open: boolean, flyoutOpen: boolean): EscapeStep {
  if (!open) return 'pass'
  return flyoutOpen ? 'flyout' : 'menu'
}

/**
 * Agent and model chooser, shaped as a native-style menu with a flyout.
 *
 * Level one is the agent; hovering it opens its models beside the menu rather
 * than replacing it, so the agent list stays visible while browsing. Agents own
 * their catalogs and enumerate at runtime — pi alone can return two dozen models
 * across several machines — so the flyout groups by provider and offers search.
 */
export function ModelPicker({
  backends,
  backendId,
  modelId,
  onSelect,
  onRefresh,
  loading = false,
  error = null,
  dropUp = false,
  disabled = false
}: ModelPickerProps): ReactNode {
  const { settings } = useAppState()
  const visibleBackends = listedBackends(backends, settings?.backends, backendId)
  const [open, setOpen] = useState(false)
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }

    /*
     * On the document, in the capture phase — not on the menu.
     *
     * Opening the menu with the mouse leaves focus on the TRIGGER, which is a
     * sibling of the menu, so a React `onKeyDown` on the menu never fired and
     * Escape fell through to the global handler: in the bot editor that closed
     * the whole dialog and lost the edit in progress. Capture also puts this
     * ahead of that handler, which listens on `window` as the event bubbles
     * back up, so stopping propagation here is what keeps the key from acting
     * twice. The mention picker listens on `window` in capture, one step
     * earlier still, so it keeps its claim on Escape.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return
      const step = escapeStep(true, flyout !== null)
      if (step === 'pass') return
      e.preventDefault()
      e.stopPropagation()
      if (step === 'flyout') setFlyout(null)
      else setOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, flyout])

  // Reopening always starts clean; the current agent's flyout is not forced.
  useEffect(() => {
    if (!open) setFlyout(null)
  }, [open])

  const current = backends.find((b) => b.id === backendId)
  const currentModel = current?.models.find((m) => m.id === modelId)
  /*
   * The agent name comes from the bot (or the known id) and does not wait on
   * detection. Waiting painted "Choose model" while Settings already said
   * Codex — and the reply then introduced itself as whichever CLI the bot
   * actually ran, often Kimi. A specific model id is shown as soon as the bot
   * has one; the catalog label replaces it when the probe returns.
   */
  const agent = current?.label || KNOWN_BACKEND_LABELS[backendId] || backendId
  const specificModel = Boolean(modelId && modelId !== 'default')
  const modelText = currentModel?.label || modelId
  const label = agent ? (specificModel ? `${agent} · ${modelText}` : agent) : 'Choose model'

  return (
    <div className="ob-mp" ref={root}>
      <button
        type="button"
        className="ob-mp-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${current ? `${current.label}, ` : ''}${label}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ob-mp-trigger-text">{label}</span>
        {current && current.status !== 'available' ? (
          <span className={`ob-mp-dot ${STATUS_TONE[current.status]}`} />
        ) : null}
        <IconChevronDown size={11} />
      </button>

      {/* The menu carries no key handler: Escape is caught on the document,
          because focus is on the trigger beside it. See the effect above. */}
      {open ? (
        <div className={`ob-menu${dropUp ? ' ob-menu-up' : ''}`} role="menu" aria-label="Choose a CLI and model">
          <div className="ob-menu-head">
            <span>CLI</span>
            <button
              type="button"
              className="ob-icon-btn"
              onClick={onRefresh}
              aria-label="Re-detect CLIs"
              disabled={loading}
            >
              {loading ? <IconSpinner size={11} /> : <IconRefresh size={11} />}
            </button>
          </div>

          {error ? (
            <p className="ob-menu-error">
              <IconWarning size={11} />
              {error}
            </p>
          ) : null}

          {visibleBackends.length === 0 && !loading ? (
            <p className="ob-menu-empty">
              No agents detected. Install one, or add an API key in Settings.
            </p>
          ) : null}

          <BackendMenu
            backends={visibleBackends}
            backendId={backendId}
            activeId={flyout?.backend.id ?? null}
            onHover={(backend, top) => setFlyout({ backend, top })}
          />

          {flyout ? (
            <div
              className="ob-menu ob-menu-flyout"
              role="menu"
              aria-label={`${flyout.backend.label} models`}
              style={{ top: flyout.top }}
            >
              <ModelMenu
                backend={flyout.backend}
                backendId={backendId}
                modelId={modelId}
                onPick={(picked) => {
                  onSelect(flyout.backend.id, picked)
                  setOpen(false)
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
