import { useEffect, useState, type ReactNode } from 'react'
import type { Project } from '../../../shared/types'
import { fetchProject, openBoard, openBotChat, openProjectEditor, selectSession, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconFolder, IconList, IconPencil } from './Icons'
import { relativeTime } from '../lib/format'
import { resolveSettingsLang } from '../lib/settingsCopy'
import './ProjectView.css'

/**
 * A project's home, shown in the main pane instead of a transcript.
 *
 * Selecting a project is a navigation act, not a filter: the user wants to see
 * what the project contains — its chats, bots, folder and outstanding cards —
 * before deciding where to go next.
 */
export function ProjectView(): ReactNode {
  const { projects, projectHome, sessions, bots, currentSessionId, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const project = projects.find((p) => p.id === projectHome)

  /*
   * The summary carries counts, not the bot list or folder, so the full record
   * is fetched on open. Kept local: nothing else needs it, and it must refresh
   * when the project is edited.
   */
  const [full, setFull] = useState<Project | null>(null)
  useEffect(() => {
    let live = true
    if (!projectHome) {
      setFull(null)
      return
    }
    void fetchProject(projectHome).then((p) => {
      if (live) setFull(p)
    })
    return () => {
      live = false
    }
  }, [projectHome, project?.updatedAt])

  if (!project) return null

  const chats = sessions.filter((s) => s.projectId === project.id && !s.archived)
  const members = bots.filter((b) => full?.botIds?.includes(b.id))

  return (
    <div className="ob-projview">
      <div className="ob-projview-inner">
        <header className="ob-projview-head">
          <span className="ob-projview-emoji" aria-hidden="true">
            {project.emoji}
          </span>
          <div className="ob-projview-title">
            <h1>{project.name}</h1>
            <div className="ob-projview-meta">
              {project.tags.map((tag) => (
                <span key={tag} className="ob-pill">
                  {tag}
                </span>
              ))}
              <span className="ob-projview-count">
                {zh ? `${chats.length} 个对话` : `${chats.length} chat${chats.length === 1 ? '' : 's'}`}
              </span>
              <span className="ob-projview-count">{zh ? `${project.openCards} 项待办` : `${project.openCards} open`}</span>
            </div>
          </div>
          <button
            type="button"
            className="ob-icon-btn"
            aria-label={zh ? `编辑 ${project.name}` : `Edit ${project.name}`}
            onClick={() => openProjectEditor(project.id)}
          >
            <IconPencil size={13} />
          </button>
        </header>

        <div className="ob-projview-actions">
          <button
            type="button"
            className="ob-btn ob-btn-sm ob-btn-primary"
            disabled={!full?.botIds.some((id) => bots.some((bot) => bot.id === id && !bot.archived))}
            onClick={() => {
              const botId = full?.botIds.find((id) => bots.some((bot) => bot.id === id && !bot.archived))
              if (botId) void openBotChat(botId)
            }}
          >
            {zh ? '打开对话' : 'Open conversation'}
          </button>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => void openBoard(project.id)}>
            <IconList size={12} />
            {zh ? '看板' : 'Board'}
          </button>
        </div>

        <section className="ob-projview-section">
          <h2>{zh ? '对话' : 'Chats'}</h2>
          {chats.length === 0 ? (
            <p className="ob-projview-empty">
              {zh ? '此项目暂无对话。' : 'No conversations in this project yet.'}
            </p>
          ) : (
            <ul className="ob-projview-list">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    className={`ob-projview-chat${chat.id === currentSessionId ? ' is-current' : ''}`}
                    onClick={() => void selectSession(chat.id)}
                  >
                    <span className="ob-projview-chat-avatars">
                      {chat.botIds.slice(0, 3).map((id) => (
                        <BotAvatar key={id} bot={bots.find((b) => b.id === id)} size="sm" />
                      ))}
                    </span>
                    <span className="ob-projview-chat-title">{chat.title}</span>
                    <span className="ob-projview-chat-when">{zh ? new Date(chat.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : relativeTime(chat.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ob-projview-section">
          <h2>Bots</h2>
          {members.length === 0 ? (
            <p className="ob-projview-empty">
              {zh ? '尚未添加 Bot。可在项目设置中添加。' : 'No bots assigned. Add them in the project settings.'}
            </p>
          ) : (
            <ul className="ob-projview-bots">
              {members.map((bot) => (
                <li key={bot.id}>
                  <BotAvatar bot={bot} size="sm" />
                  <span>{bot.name}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ob-projview-section">
          <h2>{zh ? '文件夹' : 'Folder'}</h2>
          <p className="ob-projview-folder">
            <IconFolder size={12} />
            <span>{full?.cwd || (zh ? '未设置' : 'Not set')}</span>
          </p>
        </section>
      </div>
    </div>
  )
}
