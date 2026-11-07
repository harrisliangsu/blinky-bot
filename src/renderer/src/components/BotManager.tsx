import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentGroup, Bot } from '../../../shared/types'
import { findBotTemplates, type BotTemplate } from '../../../shared/botTemplates'
import { createBackgroundTask, duplicateBot, openBotChat, removeGroup, store, updateBot, updateGroup, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { BotEditor } from './BotEditor'
import { useBotChinese } from './BotUiLanguage'
import { IconArchive, IconCopy, IconPlay, IconPlus, IconTrash } from './Icons'
import { FormDialog } from './FormDialog'
import { GroupEditor } from './GroupEditor'
import { Modal } from './Modal'
import './BotManager.css'

type Selection = { mode: 'none' } | { mode: 'new'; templateId?: string } | { mode: 'edit'; id: string }

function initialSelection(draftId: string | null): Selection {
  if (draftId === 'new') return { mode: 'new' }
  if (draftId) return { mode: 'edit', id: draftId }
  return { mode: 'none' }
}

/** Bot gallery with an editing drawer. */
export function BotManager(): ReactNode {
  const zh = useBotChinese()
  const { bots, groups, botsError, backends, backendsLoading, backendsError, botDraftId } = useAppState()
  const [selection, setSelection] = useState<Selection>(() => initialSelection(botDraftId))
  const escapeCloseEditor = useRef<(() => void) | null>(null)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [groupEditor, setGroupEditor] = useState<AgentGroup | null | undefined>(undefined)
  const [broadcast, setBroadcast] = useState('')
  const [showTemplates, setShowTemplates] = useState(false)
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateCategory, setTemplateCategory] = useState<BotTemplate['category'] | 'all'>('all')

  const selected: Bot | null = selection.mode === 'edit' ? bots.find((b) => b.id === selection.id) ?? null : null
  const template = selection.mode === 'new' && selection.templateId ? findBotTemplates('').find((item) => item.id === selection.templateId) : undefined
  const editorOpen = selection.mode !== 'none'
  const group = groups.find((item) => item.id === groupId) ?? null
  const shownBots = useMemo(() => {
    const list = group ? bots.filter((bot) => group.botIds.includes(bot.id)) : bots
    return [...list].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || a.createdAt - b.createdAt)
  }, [bots, group])
  const shownTemplates = findBotTemplates(templateQuery).filter((item) => templateCategory === 'all' || item.category === templateCategory)

  return (
    <Modal
      title={zh ? 'Bot 管理' : 'Bots'}
      subtitle={zh ? '为不同工作创建和配置你的 Bot。' : 'Create and configure a bot for each kind of work.'}
      size="lg"
      onClose={() => store.setModal(null)}
      onEscape={() => { if (editorOpen) escapeCloseEditor.current?.(); else store.setModal(null) }}
      actions={
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => store.setModal('bots', 'new')}>
          <IconPlus size={12} />
          {zh ? '创建 Bot' : 'New bot'}
        </button>
      }
    >
      <div className="ob-bots">
        <div className="ob-bots-grid-wrap">
          <div className="ob-bot-groups">
            <button type="button" className={`ob-btn ob-btn-sm${group || showTemplates ? '' : ' ob-btn-primary'}`} onClick={() => { setShowTemplates(false); setGroupId(null) }}>{zh ? '全部 Bot' : 'All bots'}</button>
            <button type="button" className={`ob-btn ob-btn-sm${showTemplates ? ' ob-btn-primary' : ''}`} onClick={() => { setShowTemplates(true); setSelection({ mode: 'none' }); setGroupId(null) }}>{zh ? '模板' : 'Templates'}</button>
            {groups.map((item) => <button key={item.id} type="button" className={`ob-btn ob-btn-sm${group?.id === item.id ? ' ob-btn-primary' : ''}`} onClick={() => { setShowTemplates(false); setGroupId(item.id) }}>{item.pinned ? '★ ' : ''}{item.name}</button>)}
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => setGroupEditor(null)}>{zh ? '新建分组' : 'New group'}</button>
          </div>

          {!showTemplates && group ? <section className="ob-group-panel">
            <header><div><strong>{group.name}</strong><span>{group.botIds.length} {zh ? '个 Bot' : `member${group.botIds.length === 1 ? '' : 's'}`}</span></div><span>
              <button type="button" className="ob-btn ob-btn-sm" onClick={() => void updateGroup(group.id, { pinned: !group.pinned })}>{zh ? (group.pinned ? '取消置顶' : '置顶分组') : (group.pinned ? 'Unpin' : 'Pin group')}</button>
              <button type="button" className="ob-icon-btn" aria-label={zh ? `删除 ${group.name}` : `Delete ${group.name}`} onClick={() => { void removeGroup(group.id); setGroupId(null) }}><IconTrash size={11} /></button>
            </span></header>
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => setGroupEditor(group)}>{zh ? '编辑分组' : 'Edit group'}</button>
            <div className="ob-group-broadcast"><input className="ob-input" value={broadcast} placeholder={zh ? '向每个成员发送独立任务…' : 'Send independent work to each member…'} onChange={(event) => setBroadcast(event.target.value)} /><button type="button" className="ob-btn ob-btn-primary ob-btn-sm" disabled={!broadcast.trim() || group.botIds.length === 0} onClick={() => {
              const prompt = broadcast.trim(); setBroadcast('')
              for (const botId of group.botIds) void createBackgroundTask(botId, prompt, `${group.name}: ${prompt.slice(0, 60)}`)
              store.toast(zh ? `已向 ${group.botIds.length} 个 Bot 发送任务。` : `Started work for ${group.botIds.length} bot${group.botIds.length === 1 ? '' : 's'}.`)
            }}><IconPlay size={11} /> {zh ? '发送任务' : 'Send tasks'}</button></div>
          </section> : null}
          {botsError ? (
            <p className="ob-notice ob-notice-error" role="alert">
              {botsError}
            </p>
          ) : null}

          {showTemplates ? (
            <section aria-label={zh ? 'Bot 模板' : 'Bot templates'}>
              <p className="ob-hint">{zh ? '浏览本机模板，创建后可在 Bot 详情中调整配置。' : 'Browse local templates; adjust their configuration in bot details after creating one.'}</p>
              <input className="ob-input" aria-label={zh ? '搜索 Bot 模板' : 'Search bot templates'} placeholder={zh ? '搜索模板' : 'Search templates'} value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} />
              <div className="ob-bot-groups ob-template-categories" aria-label={zh ? '模板分类' : 'Template categories'}>
                {([['all', '全部', 'All'], ['development', '开发', 'Development'], ['research', '研究', 'Research'], ['writing', '写作', 'Writing'], ['planning', '规划', 'Planning']] as const).map(([id, label, en]) => (
                  <button key={id} type="button" className={`ob-btn ob-btn-sm${templateCategory === id ? ' ob-btn-primary' : ''}`} aria-pressed={templateCategory === id} onClick={() => setTemplateCategory(id)}>{zh ? label : en}</button>
                ))}
              </div>
              <ul className="ob-bots-grid ob-template-grid">
                {shownTemplates.map((item) => <li key={item.id}>
                  <div className="ob-bot-card">
                    <div className="ob-bot-card-main">
                      <span aria-hidden="true">{item.emoji}</span>
                      <span className="ob-bot-card-name">{item.name}</span>
                      <span className="ob-bot-card-desc">{item.description}</span>
                    </div>
                    <button type="button" className="ob-btn ob-btn-sm ob-bot-card-chat" onClick={() => store.setModal('bots', `new:${item.id}`)}>{zh ? '使用模板' : 'Use template'}</button>
                  </div>
                </li>)}
              </ul>
              {shownTemplates.length === 0 ? <p className="ob-hint">{zh ? '没有找到匹配的模板。' : 'No matching templates.'}</p> : null}
            </section>
          ) : bots.length === 0 && !botsError ? (
            <div className="ob-empty">
              <h3 className="ob-empty-title">{zh ? '还没有 Bot' : 'No bots yet'}</h3>
              <p className="ob-empty-body">{zh ? '创建一个 Bot，设置它的职责和能力。' : 'Create a bot and give it a role and capabilities.'}</p>
              <button type="button" className="ob-btn ob-btn-primary" onClick={() => store.setModal('bots', 'new')}>
                {zh ? '创建第一个 Bot' : 'Create the first bot'}
              </button>
            </div>
          ) : (
            <ul className="ob-bots-grid">
              {shownBots.map((bot) => (
                <li key={bot.id} data-bot-id={bot.id}>
                  <div className={`ob-bot-card${selection.mode === 'edit' && selection.id === bot.id ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      className="ob-bot-card-main"
                      onClick={() => setSelection({ mode: 'edit', id: bot.id })}
                      aria-label={zh ? `编辑 ${bot.name}` : `Edit ${bot.name}`}
                    >
                      <BotAvatar bot={bot} size="lg" />
                      <span className="ob-bot-card-name">{bot.name}</span>
                      <span className="ob-bot-card-desc">{bot.description || (zh ? '暂无简介' : 'No description')}</span>
                      <span className="ob-bot-card-tags">
                        <span className="ob-pill">{bot.tools.length} {zh ? '项工具' : 'tools'}</span>
                        {bot.computerUse ? <span className="ob-pill ob-pill-accent">{zh ? '电脑操作' : 'computer'}</span> : null}
                        {bot.archived ? <span className="ob-pill ob-pill-warn">{zh ? '已归档' : 'archived'}</span> : null}
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
                      title={bot.archived ? (zh ? '恢复后即可打开对话。' : 'Restore this bot to chat with it.') : undefined}
                    >
                      {zh ? '打开对话' : 'Open chat'}
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
                        aria-label={bot.archived ? (zh ? `恢复 ${bot.name}` : `Restore ${bot.name}`) : (zh ? `归档 ${bot.name}` : `Archive ${bot.name}`)}
                        aria-pressed={bot.archived === true}
                        onClick={() => void updateBot(bot.id, { archived: !bot.archived })}
                      >
                        <IconArchive size={11} />
                      </button>
                      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void updateBot(bot.id, { pinned: !bot.pinned })}>{zh ? (bot.pinned ? '★ 已置顶' : '☆ 置顶') : (bot.pinned ? '★ Pinned' : '☆ Pin')}</button>
                      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void duplicateBot(bot.id)}><IconCopy size={11} /> {zh ? '复制' : 'Duplicate'}</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {editorOpen ? (
          <FormDialog title={zh ? '编辑 Bot' : 'Edit bot'} size="md" fallbackFocus={selected ? `[data-bot-id="${CSS.escape(selected.id)}"] .ob-bot-card-main` : undefined} onClose={() => escapeCloseEditor.current?.()}>
            <BotEditor
              bot={selected}
              inDialog
              template={template}
              backends={backends}
              backendsLoading={backendsLoading}
              backendsError={backendsError}
              onClose={() => setSelection({ mode: 'none' })}
              onSaved={() => setSelection({ mode: 'none' })}
              escapeCloseRef={escapeCloseEditor}
            />
          </FormDialog>
        ) : null}
        {groupEditor !== undefined ? <GroupEditor key={groupEditor?.id ?? 'new'} group={groupEditor} bots={bots} zh={zh} onClose={() => setGroupEditor(undefined)} onSaved={saved => { setGroupId(saved.id); setGroupEditor(undefined) }} /> : null}
      </div>
    </Modal>
  )
}
