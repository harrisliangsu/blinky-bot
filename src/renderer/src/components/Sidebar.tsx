import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { openSettings, type SettingsSection } from '../lib/settingsNavigation'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { newSession, openBotChat, selectProject, store, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconBot, IconClose, IconPencil, IconPlus, IconSearch, IconSettings } from './Icons'
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
  const { sessions, sessionsError, currentSessionId, bots, projects, currentProjectId, settings } = useAppState()
  const copy = useSettingsCopy()
  const [query, setQuery] = useState('')
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountMore, setAccountMore] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!accountOpen) return
    const onDown = (event: MouseEvent): void => {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false)
        setAccountMore(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.repeat) return
      if (store.getState().approvals.length > 0) return
      event.preventDefault()
      event.stopPropagation()
      setAccountOpen(false)
      setAccountMore(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [accountOpen])

  const openAccountTab = (tab: SettingsSection): void => {
    setAccountOpen(false)
    setAccountMore(false)
    openSettings(tab)
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
  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null

  return (
    <aside className="ob-sidebar" aria-label="Navigation">
      <div className="ob-side-head">
        <span className="ob-side-brand">BlinkyBot</span>
        <button
          type="button"
          className="ob-icon-btn ob-no-drag"
          onClick={() => void newSession()}
          title={currentProject ? `New chat in ${currentProject.name}` : 'New chat'}
          aria-label={currentProject ? `New chat in ${currentProject.name} (Command N)` : 'New chat (Command N)'}
        >
          <IconPlus size={13} />
        </button>
      </div>

      <div className="ob-side-search">
        <IconSearch size={12} />
        <input
          className="ob-side-search-input"
          type="search"
          value={query}
          placeholder={copy.more.search}
          aria-label={copy.more.search}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="ob-side-scroll">
        {currentProject ? (
          <p className="ob-side-filter">
            <span className="ob-side-filter-text">
              {currentProject.emoji} {currentProject.name} chats
            </span>
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={`Stop filtering by ${currentProject.name}`}
              onClick={() => selectProject(null)}
            >
              <IconClose size={11} />
            </button>
          </p>
        ) : null}

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
                <li key={bot.id} className={`ob-side-item${openBotIds.has(bot.id) ? ' is-current' : ''}`}>
                  <button
                    type="button"
                    className="ob-side-item-main"
                    aria-current={openBotIds.has(bot.id) ? 'true' : undefined}
                    onClick={() => void openBotChat(bot.id)}
                    title={bot.description || bot.name}
                  >
                    <BotAvatar bot={bot} size="sm" />
                    <span className="ob-side-item-name">{bot.name}</span>
                  </button>
                  <button
                    type="button"
                    className="ob-icon-btn ob-side-item-action"
                    aria-label={`Edit ${bot.name}`}
                    onClick={() => store.setModal('bots', bot.id)}
                  >
                    <IconPencil size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <footer className="ob-side-foot">
        <div className="ob-side-account" ref={accountRef}>
          {accountOpen ? (
            <div className="ob-side-popover" id="ob-side-account-menu" role="menu" aria-label={copy.account.menu}>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('general')}>
                {copy.title}
              </button>
              <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('apps')}>
                {copy.nav.apps}
              </button>
              <button
                type="button"
                role="menuitem"
                className="ob-side-popover-item"
                aria-expanded={accountMore}
                onClick={() => setAccountMore((open) => !open)}
              >
                {copy.account.more}
              </button>
              {accountMore ? (
                <div className="ob-side-popover-more" role="group" aria-label={copy.account.more}>
                  <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('permissions')}>
                    {copy.nav.permissions}
                  </button>
                  <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('updates')}>
                    {copy.nav.updates}
                  </button>
                  <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('about')}>
                    {copy.nav.about}
                  </button>
                  <button type="button" role="menuitem" className="ob-side-popover-item" onClick={() => openAccountTab('profile')}>
                    {copy.nav.profile}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="ob-side-profile"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-controls="ob-side-account-menu"
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span className="ob-profile-avatar" style={{ background: settings?.profileColor ?? '#7c9cff' }} aria-hidden="true">
              {settings?.profileEmoji ?? '🙂'}
            </span>
            <span>{settings?.profileName || copy.nav.profile}</span>
          </button>
        </div>
        <button type="button" className="ob-icon-btn" onClick={() => openSettings('general')} aria-label="Settings (Command comma)">
          <IconSettings size={13} />
        </button>
      </footer>
    </aside>
  )
}
