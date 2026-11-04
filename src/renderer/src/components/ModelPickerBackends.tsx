import type { ReactNode } from 'react'
import type { BackendInfo, BackendStatus } from '../../../shared/types'
import { IconChevronRight } from './Icons'

export const STATUS_TEXT: Record<BackendStatus, string> = {
  available: 'Ready',
  'not-installed': 'Not installed',
  'not-running': 'Not running',
  'needs-key': 'Sign in needed',
  error: 'Error'
}

export const STATUS_TONE: Record<BackendStatus, string> = {
  available: 'ob-pill-ok',
  'not-installed': 'ob-pill-warn',
  'not-running': 'ob-pill-warn',
  'needs-key': 'ob-pill-warn',
  error: 'ob-pill-bad'
}

/** A monogram stands in for a vendor mark — no bundled brand assets. */
const GLYPH: Record<string, string> = {
  opencode: 'oc',
  claude: 'cl',
  codex: 'cx',
  kimi: 'ki',
  grok: 'gk',
  pi: 'pi',
  droid: 'dr',
  openai: 'ai',
  anthropic: 'an',
  xai: 'x',
  openrouter: 'or'
}

interface BackendMenuProps {
  backends: BackendInfo[]
  backendId: string
  /** Which row currently has its submenu open. */
  activeId: string | null
  onHover: (backend: BackendInfo, top: number) => void
}

function Row({
  backend,
  selected,
  active,
  onHover
}: {
  backend: BackendInfo
  selected: boolean
  active: boolean
  onHover: (top: number) => void
}): ReactNode {
  const ready = backend.status === 'available'
  // Mouse and keyboard both open the flyout, so accept either event type.
  const open = (e: { currentTarget: HTMLButtonElement }): void => {
    if (!ready) return
    onHover(e.currentTarget.offsetTop)
  }

  return (
    <button
      type="button"
      className={`ob-menu-item${active ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}
      disabled={!ready}
      aria-disabled={!ready}
      aria-haspopup={ready ? 'menu' : undefined}
      aria-expanded={ready ? active : undefined}
      title={ready ? undefined : backend.statusDetail}
      onMouseEnter={open}
      onFocus={open}
      onClick={open}
    >
      <span className="ob-menu-glyph" aria-hidden="true">
        {GLYPH[backend.id] ?? backend.label.slice(0, 2).toLowerCase()}
      </span>
      <span className="ob-menu-label">{backend.label}</span>
      {ready ? (
        <IconChevronRight size={12} />
      ) : (
        <span className={`ob-pill ${STATUS_TONE[backend.status]}`}>{STATUS_TEXT[backend.status]}</span>
      )}
    </button>
  )
}

/**
 * Level one: the agents themselves.
 *
 * Agents that run on this machine come first — they bring their own auth and
 * model routing. Unavailable ones stay visible so the reason is discoverable,
 * but cannot be opened.
 */
export function BackendMenu({
  backends,
  backendId,
  activeId,
  onHover
}: BackendMenuProps): ReactNode {
  const clis = backends.filter((b) => b.kind === 'agent-cli')
  const direct = backends.filter((b) => b.kind !== 'agent-cli')

  const section = (label: string, items: BackendInfo[]): ReactNode =>
    items.length === 0 ? null : (
      <>
        <div className="ob-menu-section">{label}</div>
        {items.map((backend) => (
          <Row
            key={backend.id}
            backend={backend}
            selected={backend.id === backendId}
            active={backend.id === activeId}
            onHover={(top) => onHover(backend, top)}
          />
        ))}
      </>
    )

  return (
    <>
      {section('On this machine', clis)}
      {direct.length && clis.length ? <div className="ob-menu-sep" /> : null}
      {section('Direct API', direct)}
    </>
  )
}
