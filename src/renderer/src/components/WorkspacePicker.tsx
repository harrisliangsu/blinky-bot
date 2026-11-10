import { useMemo, useState, type ReactNode } from 'react'
import { relativeTime } from '../lib/format'
import { resolveSettingsLang } from '../lib/settingsCopy'
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
  const { sessions, sessionsLoading, bots, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [query, setQuery] = useState('')

  const open = useMemo(() => [...sessions].filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt), [sessions])
  const needle = query.trim().toLowerCase()
  const shown = needle ? open.filter((s) => s.title.toLowerCase().includes(needle)) : open

  return (
    <div className="ob-slot">
      <header className="ob-slot-head">
        <span className="ob-slot-name">{zh ? `窗格 ${index + 1}` : `Pane ${index + 1}`}</span>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          onClick={() => void startPaneChat(index)}
          aria-label={zh ? `打开对话到窗格 ${index + 1}` : `Open a conversation in pane ${index + 1}`}
        >
          <IconPlus size={11} />
          {zh ? '打开对话' : 'Open conversation'}
        </button>
      </header>

      {open.length > 4 ? (
        <input
          type="search"
          className="ob-input ob-slot-search"
          value={query}
          placeholder={zh ? '搜索对话' : 'Find a conversation'}
          aria-label={zh ? `搜索窗格 ${index + 1} 的对话` : `Filter conversations for pane ${index + 1}`}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}

      {sessionsLoading && open.length === 0 ? <p className="ob-slot-empty">{zh ? '正在载入对话…' : 'Loading conversations…'}</p> : null}

      {!sessionsLoading && open.length === 0 ? (
        <p className="ob-slot-empty">{zh ? '还没有可打开的对话。' : 'No conversations available yet.'}</p>
      ) : null}

      {open.length > 0 && shown.length === 0 ? <p className="ob-slot-empty">{zh ? `没有找到与“${query}”匹配的对话。` : `Nothing matches “${query}”.`}</p> : null}

      <ul className="ob-slot-list">
        {shown.map((s) => {
          const participants = s.botIds.map((id) => bots.find((b) => b.id === id)).filter((b) => b !== undefined)
          return (
            <li key={s.id}>
              <button
                type="button"
                className="ob-slot-item"
                onClick={() => assignPane(index, s.id)}
                aria-label={zh ? `在窗格 ${index + 1} 显示 ${s.title}` : `Show ${s.title} in pane ${index + 1}`}
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
                    {zh ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : relativeTime(s.updatedAt)}
                    {taken.has(s.id) ? (zh ? ' · 已在其他窗格打开' : ' · already in a pane') : ''}
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
