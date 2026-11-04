import { useMemo, useState, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { newSession, openProjectEditor, projectsReady, runRoutine, selectProject, store, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import {
  IconArchive,
  IconBoard,
  IconBot,
  IconClose,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRoutine,
  IconSearch,
  IconSettings
} from './Icons'
import { ProjectList } from './ProjectList'
import { SessionList } from './SessionList'
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

/** Conversations, bots and routines — the app's primary navigation. */
export function Sidebar(): ReactNode {
  const { sessions, sessionsLoading, sessionsError, currentSessionId, bots, routines, recording, projects, currentProjectId, settings } =
    useAppState()
  const copy = useSettingsCopy()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots])
  const activeBots = useMemo(() => bots.filter((b) => !b.archived), [bots])
  const archivedCount = sessions.filter((s) => s.archived).length
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
          placeholder="Search conversations"
          aria-label="Search conversations"
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
          {activeBots.length === 0 ? (
            <p className="ob-side-note">No bots yet. Create one to give the agent a persona and its own memory.</p>
          ) : (
            <ul className="ob-side-list">
              {activeBots.map((bot) => (
                <li key={bot.id} className="ob-side-item">
                  <button
                    type="button"
                    className="ob-side-item-main"
                    onClick={() => void newSession([bot.id])}
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

        <SessionList
          sessions={sessions}
          bots={botMap}
          currentId={currentSessionId}
          query={query}
          showArchived={showArchived}
          loading={sessionsLoading}
          error={sessionsError}
          projectId={currentProjectId}
          projectName={currentProject?.name}
        />

        <details className="ob-side-more">
          <summary>{copy.more.title}</summary>
        <Section
          title={copy.more.projects}
          icon={<IconBoard size={12} />}
          action={{ label: 'Create a project', onClick: () => openProjectEditor('new'), disabled: !projectsReady() }}
        >
          <ProjectList />
        </Section>

        <Section
          title={copy.more.routines}
          icon={<IconRoutine size={12} />}
          action={{ label: 'Record a routine', onClick: () => store.setModal('routines') }}
        >
          {recording.state !== 'idle' ? (
            <p className="ob-side-recording">
              <span className="ob-side-rec-dot" aria-hidden="true" />
              Recording · {recording.stepCount} step{recording.stepCount === 1 ? '' : 's'}
            </p>
          ) : null}
          {routines.length === 0 ? (
            <p className="ob-side-note">No routines yet. Record one to replay a task later.</p>
          ) : (
            <ul className="ob-side-list">
              {routines.slice(0, 8).map((routine) => (
                <li key={routine.id} className="ob-side-item">
                  <button
                    type="button"
                    className="ob-side-item-main"
                    onClick={() => store.setModal('routines')}
                    title={routine.description || routine.name}
                  >
                    <BotAvatar bot={botMap.get(routine.botId)} size="sm" />
                    <span className="ob-side-item-name">{routine.name}</span>
                    <span className="ob-side-item-count">{routine.steps.length}</span>
                  </button>
                  <button
                    type="button"
                    className="ob-icon-btn ob-side-item-action"
                    aria-label={`Run ${routine.name}`}
                    onClick={() => void runRoutine(routine.id)}
                  >
                    <IconPlay size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <button
          type="button"
          className="ob-btn ob-btn-sm ob-btn-ghost"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          <IconArchive size={12} />
          {showArchived ? copy.more.chats : copy.more.archived}
          {!showArchived && archivedCount > 0 ? <span className="ob-side-count">{archivedCount}</span> : null}
        </button>
        </details>
      </div>

      <footer className="ob-side-foot">
        <span className="ob-side-profile">
          <span className="ob-profile-avatar" style={{ background: settings?.profileColor ?? '#7c9cff' }} aria-hidden="true">
            {settings?.profileEmoji ?? '🙂'}
          </span>
          <span>{settings?.profileName || copy.nav.profile}</span>
        </span>
        <button type="button" className="ob-icon-btn" onClick={() => store.setModal('settings')} aria-label="Settings (Command comma)">
          <IconSettings size={13} />
        </button>
      </footer>
    </aside>
  )
}
