import { useMemo, useState, type ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import { createBackgroundTask, createGroup, duplicateBot, openBotChat, removeGroup, store, updateBot, updateGroup, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { BotEditor } from './BotEditor'
import { IconArchive, IconCopy, IconPlay, IconPlus, IconTrash } from './Icons'
import { Modal } from './Modal'
import './BotManager.css'

type Selection = { mode: 'none' } | { mode: 'new' } | { mode: 'edit'; id: string }

function initialSelection(draftId: string | null): Selection {
  if (draftId === 'new') return { mode: 'new' }
  if (draftId) return { mode: 'edit', id: draftId }
  return { mode: 'none' }
}

/** Bot gallery with an editing drawer. */
export function BotManager(): ReactNode {
  const { bots, groups, botsError, backends, backendsLoading, backendsError, botDraftId } = useAppState()
  const [selection, setSelection] = useState<Selection>(() => initialSelection(botDraftId))
  const [groupId, setGroupId] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [broadcast, setBroadcast] = useState('')

  const selected: Bot | null = selection.mode === 'edit' ? bots.find((b) => b.id === selection.id) ?? null : null
  const editorOpen = selection.mode !== 'none'
  const group = groups.find((item) => item.id === groupId) ?? null
  const shownBots = useMemo(() => {
    const list = group ? bots.filter((bot) => group.botIds.includes(bot.id)) : bots
    return [...list].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || a.createdAt - b.createdAt)
  }, [bots, group])

  return (
    <Modal
      title="Bots"
      subtitle="Personas with their own prompt, tools and memory."
      size="lg"
      onClose={() => store.setModal(null)}
      actions={
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => setSelection({ mode: 'new' })}>
          <IconPlus size={12} />
          New bot
        </button>
      }
    >
      <div className={`ob-bots${editorOpen ? ' is-editing' : ''}`}>
        <div className="ob-bots-grid-wrap">
          <div className="ob-bot-groups">
            <button type="button" className={`ob-btn ob-btn-sm${group ? '' : ' ob-btn-primary'}`} onClick={() => setGroupId(null)}>All bots</button>
            {groups.map((item) => <button key={item.id} type="button" className={`ob-btn ob-btn-sm${group?.id === item.id ? ' ob-btn-primary' : ''}`} onClick={() => setGroupId(item.id)}>{item.pinned ? '★ ' : ''}{item.name}</button>)}
            <input className="ob-input ob-group-name" value={newGroupName} placeholder="New group" aria-label="New group name" onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && newGroupName.trim()) void createGroup(newGroupName).then((created) => { if (created) setGroupId(created.id); setNewGroupName('') })
            }} />
          </div>

          {group ? <section className="ob-group-panel">
            <header><div><strong>{group.name}</strong><span>{group.botIds.length} member{group.botIds.length === 1 ? '' : 's'}</span></div><span>
              <button type="button" className="ob-btn ob-btn-sm" onClick={() => void updateGroup(group.id, { pinned: !group.pinned })}>{group.pinned ? 'Unpin' : 'Pin group'}</button>
              <button type="button" className="ob-icon-btn" aria-label={`Delete ${group.name}`} onClick={() => { void removeGroup(group.id); setGroupId(null) }}><IconTrash size={11} /></button>
            </span></header>
            <div className="ob-group-members">{bots.filter((bot) => !bot.archived).map((bot) => <label key={bot.id} className="ob-check"><input type="checkbox" checked={group.botIds.includes(bot.id)} onChange={() => void updateGroup(group.id, { botIds: group.botIds.includes(bot.id) ? group.botIds.filter((id) => id !== bot.id) : [...group.botIds, bot.id] })} /><span>{bot.emoji} {bot.name}</span></label>)}</div>
            <div className="ob-group-broadcast"><input className="ob-input" value={broadcast} placeholder="Broadcast independent work to every member…" onChange={(event) => setBroadcast(event.target.value)} /><button type="button" className="ob-btn ob-btn-primary ob-btn-sm" disabled={!broadcast.trim() || group.botIds.length === 0} onClick={() => {
              const prompt = broadcast.trim(); setBroadcast('')
              for (const botId of group.botIds) void createBackgroundTask(botId, prompt, `${group.name}: ${prompt.slice(0, 60)}`)
              store.toast(`Broadcast started for ${group.botIds.length} bot${group.botIds.length === 1 ? '' : 's'}.`)
            }}><IconPlay size={11} /> Broadcast</button></div>
          </section> : null}
          {botsError ? (
            <p className="ob-notice ob-notice-error" role="alert">
              {botsError}
            </p>
          ) : null}

          {bots.length === 0 && !botsError ? (
            <div className="ob-empty">
              <h3 className="ob-empty-title">No bots yet</h3>
              <p className="ob-empty-body">A bot bundles a persona, a model, a tool set and its own memory.</p>
              <button type="button" className="ob-btn ob-btn-primary" onClick={() => setSelection({ mode: 'new' })}>
                Create the first bot
              </button>
            </div>
          ) : (
            <ul className="ob-bots-grid">
              {shownBots.map((bot) => (
                <li key={bot.id}>
                  <div className={`ob-bot-card${selection.mode === 'edit' && selection.id === bot.id ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      className="ob-bot-card-main"
                      onClick={() => setSelection({ mode: 'edit', id: bot.id })}
                      aria-label={`Edit ${bot.name}`}
                    >
                      <BotAvatar bot={bot} size="lg" />
                      <span className="ob-bot-card-name">{bot.name}</span>
                      <span className="ob-bot-card-desc">{bot.description || 'No description'}</span>
                      <span className="ob-bot-card-tags">
                        <span className="ob-pill">{bot.tools.length} tools</span>
                        {bot.computerUse ? <span className="ob-pill ob-pill-accent">computer</span> : null}
                        {bot.archived ? <span className="ob-pill ob-pill-warn">archived</span> : null}
                      </span>
                    </button>
                    {/* An archived bot has been put away, so it cannot be the one
                        a new chat opens on: every other roster — the sidebar,
                        group membership, handoff and delegate targets,
                        `defaultBotId` — already filters it out, and starting a
                        conversation from this card was the one way back in. */}
                    <button
                      type="button"
                      className="ob-btn ob-btn-sm ob-bot-card-chat"
                      onClick={() => void openBotChat(bot.id)}
                      disabled={bot.archived === true}
                      title={bot.archived ? 'Restore this bot to chat with it.' : undefined}
                    >
                      打开对话
                    </button>
                    <div className="ob-bot-card-secondary">
                      {/* The only writer of `archived`, which five readers already
                          act on — the pill beside this, the sidebar roster, group
                          membership, handoff and delegate targets, and
                          `defaultBotId`. Reversible, so it asks nothing first:
                          the same bargain the session list strikes, and the
                          reason it is not behind the editor's delete confirm. */}
                      <button
                        type="button"
                        className="ob-icon-btn"
                        aria-label={bot.archived ? `Restore ${bot.name}` : `Archive ${bot.name}`}
                        aria-pressed={bot.archived === true}
                        onClick={() => void updateBot(bot.id, { archived: !bot.archived })}
                      >
                        <IconArchive size={11} />
                      </button>
                      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void updateBot(bot.id, { pinned: !bot.pinned })}>{bot.pinned ? '★ Pinned' : '☆ Pin'}</button>
                      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void duplicateBot(bot.id)}><IconCopy size={11} /> Duplicate</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {editorOpen ? (
          <aside className="ob-bots-drawer" aria-label="Bot editor">
            <BotEditor
              bot={selected}
              backends={backends}
              backendsLoading={backendsLoading}
              backendsError={backendsError}
              onClose={() => setSelection({ mode: 'none' })}
              onSaved={(bot) => setSelection({ mode: 'edit', id: bot.id })}
            />
          </aside>
        ) : null}
      </div>
    </Modal>
  )
}
