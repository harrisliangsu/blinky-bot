import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SearchResult, SessionSummary } from '../../../shared/types'
import { useFocusTrap } from '../lib/focusTrap'
import { archiveAndClearChat, clearChat, selectProject, selectSession, store, useAppState } from '../state'
import { relativeTime } from '../lib/format'
import { IconBot, IconPlus, IconRoutine, IconSearch, IconSettings } from './Icons'
import './CommandPalette.css'

interface PaletteItem {
  id: string
  label: string
  hint?: string
  icon?: ReactNode
  run: () => void
}

/**
 * Command-K switcher: jump to a conversation or open a panel.
 *
 * The dialog is a separate component so its hooks only exist while it is open.
 * This one is mounted for the whole life of the app, and a focus trap registered
 * from here would sit at the top of the trap stack permanently, with no panel to
 * hold Tab inside — every other dialog would stop trapping.
 */
export function CommandPalette(): ReactNode {
  const { sessions, modal } = useAppState()
  if (modal !== 'palette') return null
  return <PaletteDialog sessions={sessions} />
}

function PaletteDialog({ sessions }: { sessions: SessionSummary[] }): ReactNode {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [cursor, setCursor] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /*
   * It claimed `aria-modal` while Tab walked straight out of it and into the app
   * behind the scrim — the palette sits at z-50, under the z-60 approval scrim,
   * so focus could land on controls the user could not even see.
   *
   * Before the focus below, deliberately: the trap remembers where focus was so
   * it can put it back, and it captures that when its effect runs. Focusing the
   * input first — as React's auto-focus attribute did, one phase earlier still —
   * made the palette's own input the thing to "return" to, so closing the
   * palette left focus on the body instead of back in the composer.
   */
  useFocusTrap(panelRef)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      setSearchResults([])
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      void window.openbot.search.query(needle, 60).then(
        (results) => { if (active) setSearchResults(results) },
        () => { if (active) setSearchResults([]) }
      )
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query])

  const items = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase()
    const actions: PaletteItem[] = [
      { id: 'act-clear', label: '清空对话', icon: <IconPlus size={12} />, run: () => void clearChat() },
      { id: 'act-archive-clear', label: '归档当前再清空', run: () => void archiveAndClearChat() },
      { id: 'act-bots', label: 'Bots', icon: <IconBot size={12} />, run: () => store.setModal('bots') },
      { id: 'act-routines', label: 'Routines', icon: <IconRoutine size={12} />, run: () => store.setModal('routines') },
      { id: 'act-settings', label: 'Settings', icon: <IconSettings size={12} />, run: () => store.setModal('settings') }
    ]
    const conversations: PaletteItem[] = sessions
      .filter((s) => !s.archived)
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        label: s.title || 'Untitled',
        hint: relativeTime(s.updatedAt),
        run: () => void selectSession(s.id)
      }))
    const local = needle ? [...actions, ...conversations].filter((i) => i.label.toLowerCase().includes(needle)) : [...actions, ...conversations]
    const global: PaletteItem[] = searchResults.map((result) => ({
      id: `search-${result.id}`,
      label: result.title,
      hint: `${result.kind} · ${result.snippet}`,
      run: () => {
        if (result.sessionId) void selectSession(result.sessionId)
        else if (result.projectId) selectProject(result.projectId)
        else if (result.botId) store.setModal('bots', result.botId)
        else if (result.routineId) store.setModal('routines')
      }
    }))
    const seen = new Set(local.map((item) => item.id))
    const visibleSessions = new Set(conversations.map((item) => item.id))
    return [...local, ...global.filter((item, index) => {
      if (seen.has(item.id)) return false
      const result = searchResults[index]
      return !(result?.kind === 'conversation' && result.sessionId && visibleSessions.has(result.sessionId))
    })]
  }, [sessions, query, searchResults])

  const clamped = Math.min(cursor, Math.max(0, items.length - 1))

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[clamped]
      if (item) {
        item.run()
        store.setModal(null)
      }
    }
  }

  return (
    <div className="ob-palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && store.setModal(null)}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div className="ob-palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={panelRef} onKeyDown={onKeyDown}>
        <div className="ob-palette-search">
          <IconSearch size={13} />
          <input
            ref={inputRef}
            className="ob-palette-input"
            value={query}
            placeholder="Search messages, files, links, agents and actions…"
            aria-label="Search all BlinkyBot content"
            aria-controls="ob-palette-list"
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
          />
        </div>

        <ul className="ob-palette-list" id="ob-palette-list" role="listbox" aria-label="Results">
          {items.length === 0 ? <li className="ob-palette-empty">Nothing matches that.</li> : null}
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === clamped}
                className={`ob-palette-item${i === clamped ? ' is-active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  item.run()
                  store.setModal(null)
                }}
              >
                <span className="ob-palette-icon">{item.icon}</span>
                <span className="ob-palette-label">{item.label}</span>
                {item.hint ? <span className="ob-palette-hint">{item.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
