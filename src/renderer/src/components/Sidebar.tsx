import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { openSettings, type SettingsSection } from '../lib/settingsNavigation'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { store, useAppState } from '../state'
import { UserAvatar } from './UserAvatar'
import { useBotChinese } from './BotUiLanguage'
import { IconBot, IconPlus, IconSearch, IconSettings } from './Icons'
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, sidebarMaxWidth, SIDEBAR_COMPACT_WIDTH, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebarWidth'
import { SidebarBot } from './SidebarBot'
import './Sidebar.css'

interface SectionProps {
  title: string
  icon: ReactNode
  action: { label: string; onClick: () => void; disabled?: boolean }
  children: ReactNode
}

function Section({ title, icon, action, children }: SectionProps): ReactNode {
  return (
    <section className="ob-side-section">
      <header className="ob-side-section-head">
        <span className="ob-side-section-title">
          {icon}
          {title}
        </span>
        <button
          type="button"
          className="ob-icon-btn"
          aria-label={action.label}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          <IconPlus size={12} />
        </button>
      </header>
      {children}
    </section>
  )
}

/** Bots — the app's primary navigation. */
export function Sidebar(): ReactNode {
  const { sessions, sessionsError, currentSessionId, bots, settings } = useAppState()
  const copy = useSettingsCopy()
  const zh = useBotChinese()
  const [query, setQuery] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const [preferredWidth, setPreferredWidth] = useState(readSidebarWidth)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const drag = useRef<{ pointerId: number; x: number; width: number; next: number } | null>(null)
  const mobile = window.openbot.environment?.kind === 'browser' && viewportWidth < 760
  const width = mobile ? Math.min(300, viewportWidth - 48) : clampSidebarWidth(preferredWidth, viewportWidth)
  const compact = width < SIDEBAR_COMPACT_WIDTH
  const maxWidth = sidebarMaxWidth(viewportWidth)

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const expandForSearch = (): void => {
      if (!compact) return
      const expanded = clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, window.innerWidth)
      setPreferredWidth(expanded)
      saveSidebarWidth(expanded)
    }
    window.addEventListener('openbot:expand-sidebar-for-search', expandForSearch)
    return () => window.removeEventListener('openbot:expand-sidebar-for-search', expandForSearch)
  }, [compact])

  const applyWidth = (next: number): void => {
    const bounded = clampSidebarWidth(next, window.innerWidth)
    setPreferredWidth(bounded)
    saveSidebarWidth(bounded)
  }

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, x: event.clientX, width, next: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    active.next = clampSidebarWidth(active.width + event.clientX - active.x, window.innerWidth)
    setPreferredWidth(active.next)
  }

  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    saveSidebarWidth(active.next)
  }

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 40 : 10
    const next = event.key === 'ArrowLeft' ? width - step
      : event.key === 'ArrowRight' ? width + step
        : event.key === 'Home' ? SIDEBAR_MIN_WIDTH
          : event.key === 'End' ? maxWidth : null
    if (next === null) return
    event.preventDefault()
    applyWidth(next)
  }

  useEffect(() => {
    if (!accountOpen) return
    accountRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onDown = (event: MouseEvent): void => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      setAccountOpen(false)
      accountRef.current?.querySelector<HTMLButtonElement>('.ob-side-profile')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [accountOpen])

  const openAccountTab = (tab?: SettingsSection): void => {
    // The clicked menu item disappears in this commit. Give the persistent
    // account trigger back to the modal's focus trap before opening it.
    accountRef.current?.querySelector<HTMLButtonElement>('.ob-side-profile')?.focus({ preventScroll: true })
    setAccountOpen(false)
    openSettings(tab)
    window.dispatchEvent(new Event('openbot:close-sidebar'))
  }

  const activeBots = useMemo(() => bots.filter((b) => !b.archived), [bots])
  const visibleBots = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return activeBots
    return activeBots.filter(
      (bot) => bot.name.toLowerCase().includes(needle) || (bot.description ?? '').toLowerCase().includes(needle)
    )
  }, [activeBots, query])
  const openBotIds = useMemo(() => {
    const current = sessions.find((session) => session.id === currentSessionId)
    return new Set(current?.botIds ?? [])
  }, [sessions, currentSessionId])

  return (
    <aside className={`ob-sidebar${compact ? ' is-compact' : ''}`} aria-label="Navigation" style={{ width }}>
      <div className="ob-side-head">
        <span className="ob-side-brand">BlinkyBot</span>
      </div>

      {!compact ? <div className="ob-side-search">
        <IconSearch size={12} />
        <input
          className="ob-side-search-input"
          type="search"
          value={query}
          placeholder={copy.more.search}
          aria-label={copy.more.search}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing || !query) return
            event.preventDefault()
            event.stopPropagation()
            setQuery('')
          }}
        />
      </div> : null}

      <div className="ob-side-scroll">
        <Section
          title={copy.more.bots}
          icon={<IconBot size={12} />}
          action={{ label: 'Create a bot', onClick: () => store.setModal('bots', 'new') }}
        >
          {sessionsError ? (
            <p className="ob-notice ob-notice-error ob-sessions-notice" role="alert">
              {sessionsError}
            </p>
          ) : null}
          {activeBots.length === 0 ? (
            <p className="ob-side-note">No bots yet. Create one to give it a persona and its own memory.</p>
          ) : visibleBots.length === 0 ? (
            <p className="ob-side-note">No bots match that search.</p>
          ) : (
            <ul className="ob-side-list">
              {visibleBots.map((bot) => (
                <SidebarBot key={bot.id} bot={bot} current={openBotIds.has(bot.id)} compact={compact}
                  conversation={sessions.find((item) => item.id === bot.activeConversationId)?.title} />
              ))}
            </ul>
          )}
        </Section>
      </div>

      {compact ? <div className="ob-side-compact-actions">
        <button type="button" className="ob-icon-btn" aria-label="Create a bot" title="Create a bot" onClick={() => store.setModal('bots', 'new')}><IconPlus size={15} /></button>
      </div> : null}
      <footer className="ob-side-foot">
        <div className="ob-side-account" ref={accountRef} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAccountOpen(false)
        }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey) return
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          if (!accountOpen) { setAccountOpen(true); return }
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
          items[next]?.focus()
        }}>
          {accountOpen ? (
            <div onPointerDown={event => { if ((event.target as Element).closest('[role=menuitem]')) event.preventDefault() }} className="ob-side-popover" id="ob-side-account-menu" role="menu" aria-label={copy.account.menu}>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('profile')}>
                {zh ? '编辑个人资料' : 'Edit profile'}
              </button>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab()}>
                {copy.title}
              </button>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('apps')}>
                {copy.nav.apps}
              </button>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('tools')}>
                {copy.nav.tools}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="ob-side-profile"
            aria-label={settings?.profileName || copy.nav.profile}
            title={zh ? '编辑个人资料' : 'Edit your profile'}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-controls="ob-side-account-menu"
            onClick={() => setAccountOpen((open) => !open)}
          >
            <UserAvatar profile={settings} />
            <span>{settings?.profileName || copy.nav.profile}</span>
          </button>
        </div>
        <button type="button" className="ob-icon-btn" onClick={() => { openSettings(); window.dispatchEvent(new Event('openbot:close-sidebar')) }} aria-label="Settings (Command comma)">
          <IconSettings size={13} />
        </button>
      </footer>
      <div
        className="ob-sidebar-resize"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onLostPointerCapture={onResizeEnd}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => applyWidth(SIDEBAR_DEFAULT_WIDTH)}
        title="Drag to resize sidebar"
      />
    </aside>
  )
}
