import { useMemo, useState, type ReactNode } from 'react'
import { relativeTime } from '../lib/format'
import { assignPane, startPaneChat, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconPlus } from './Icons'
import './WorkspacePicker.css'

interface WorkspacePickerProps {
  index: number
  /** Chats already shown elsewhere — allowed, but worth flagging. */
  taken: ReadonlySet<string>
}

/** An empty slot: choose which conversation goes in it, or start a new one. */
export function WorkspacePicker({ index, taken }: WorkspacePickerProps): ReactNode {
  const { sessions, sessionsLoading, bots } = useAppState()
  const [query, setQuery] = useState('')

  const open = useMemo(() => [...sessions].filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt), [sessions])
  const needle = query.trim().toLowerCase()
  const shown = needle ? open.filter((s) => s.title.toLowerCase().includes(needle)) : open

  return (
    <div className="ob-slot">
      <header className="ob-slot-head">
        <span className="ob-slot-name">Pane {index + 1}</span>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          onClick={() => void startPaneChat(index)}
          aria-label={`打开对话到窗格 ${index + 1}`}
        >
          <IconPlus size={11} />
          打开对话
        </button>
      </header>

      {open.length > 4 ? (
        <input
          type="search"
          className="ob-input ob-slot-search"
          value={query}
          placeholder="Find a conversation"
          aria-label={`Filter conversations for pane ${index + 1}`}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}

      {sessionsLoading && open.length === 0 ? <p className="ob-slot-empty">Loading conversations…</p> : null}

      {!sessionsLoading && open.length === 0 ? (
        <p className="ob-slot-empty">No conversations yet. Start one to fill this pane.</p>
      ) : null}

      {open.length > 0 && shown.length === 0 ? <p className="ob-slot-empty">Nothing matches “{query}”.</p> : null}

      <ul className="ob-slot-list">
        {shown.map((s) => {
          const participants = s.botIds.map((id) => bots.find((b) => b.id === id)).filter((b) => b !== undefined)
          return (
            <li key={s.id}>
              <button
                type="button"
                className="ob-slot-item"
                onClick={() => assignPane(index, s.id)}
                aria-label={`Show ${s.title} in pane ${index + 1}`}
              >
                <span className="ob-slot-avatars">
                  {participants.length > 0 ? (
                    participants.slice(0, 3).map((bot) => <BotAvatar key={bot.id} bot={bot} size="sm" />)
                  ) : (
                    <BotAvatar size="sm" />
                  )}
                </span>
                <span className="ob-slot-item-main">
                  <span className="ob-slot-item-title">{s.title}</span>
                  <span className="ob-slot-item-meta">
                    {relativeTime(s.updatedAt)}
                    {taken.has(s.id) ? ' · already in a pane' : ''}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
