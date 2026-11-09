import { useEffect, useId, useRef, type MutableRefObject, type ReactNode } from 'react'
import type { BackendInfo, Bot } from '../../../shared/types'
import type { BotTemplate } from '../../../shared/botTemplates'
import { resolveBotBinding } from '../../../shared/botBinding'
import { supportsFullAccessExecution, executionAccessDescription } from '../../../shared/executionAccess'
import { supportsExecutionDelegation } from '../../../shared/executionAgentCapabilities'
import { useAppState } from '../state'
import { BotRuntimeFields } from './BotRuntimeFields'
import { BotEditorIdentity } from './BotEditorIdentity'
import { BotMemory } from './BotMemory'
import { BotResourceLinks } from './BotResourceLinks'
import { useBotChinese } from './BotUiLanguage'
import { IconClose, IconTrash } from './Icons'
import { useBotDraft } from './useBotDraft'
import { useReturnFocus } from './returnFocus'
import './BotEditor.css'

interface BotEditorProps {
  /** null creates a new bot. */
  bot: Bot | null
  backends: BackendInfo[]
  backendsLoading: boolean
  backendsError: string | null
  onClose: () => void
  onSaved: (bot: Bot) => void
  escapeCloseRef?: MutableRefObject<(() => void) | null>
  embedded?: boolean
  inDialog?: boolean
  template?: BotTemplate
}

/** Create / edit form for a single bot, plus its memory. */
export function BotEditor({ bot, backends, backendsLoading, backendsError, onClose, onSaved, template, escapeCloseRef, embedded = false, inDialog = false }: BotEditorProps): ReactNode {
  useReturnFocus(!embedded && !inDialog, '.ob-bot-card.is-active .ob-bot-card-main')
  const zh = useBotChinese()
  const {
    draft,
    set,
    chooseRuntime,
    saving,
    confirmDelete,
    setConfirmDelete,
    save,
    close,
    remove
  } = useBotDraft(bot, onClose, onSaved, template)
  const { settings } = useAppState()
  const runtime = settings ? resolveBotBinding(draft, settings) : draft
  const executionAgent = draft.executionAgent ?? runtime
  const deleteLabelId = useId()
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelDeleteButton = useRef<HTMLButtonElement>(null)
  const wasConfirmingDelete = useRef(false)

  useEffect(() => {
    if (confirmDelete) cancelDeleteButton.current?.focus({ preventScroll: true })
    else if (wasConfirmingDelete.current) deleteButton.current?.focus({ preventScroll: true })
    wasConfirmingDelete.current = confirmDelete
  }, [confirmDelete])

  useEffect(() => {
    if (!escapeCloseRef) return
    escapeCloseRef.current = () => { void close() }
    return () => { escapeCloseRef.current = null }
  }, [close, escapeCloseRef])

  return (
    <div className={`ob-bot-editor${embedded ? ' is-embedded' : ''}`} onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing || !confirmDelete) return
      event.preventDefault()
      event.stopPropagation()
      if (!saving) setConfirmDelete(false)
    }}>
      {!embedded && !inDialog ? <header className="ob-bot-editor-head">
        <div><span className="ob-bot-editor-eyebrow">{zh ? 'BOT 配置' : 'BOT CONFIGURATION'}</span><h3>{bot ? (zh ? '编辑 Bot' : 'Edit bot') : (zh ? '创建 Bot' : 'New bot')}</h3></div>
        <button type="button" className="ob-icon-btn" onClick={() => void close()} aria-label={zh ? '关闭编辑器' : 'Close editor'}>
          <IconClose />
        </button>
      </header> : null}

      <div className="ob-bot-editor-body">
        {!bot && window.openbot.environment?.kind === 'browser' ? <p className="ob-hint">{zh ? '创建后可立即对话。工具和电脑控制权限在 Mac 上设置。' : 'Chat is available after creation. Set tool and computer permissions on the Mac.'}</p> : null}
        <BotEditorIdentity
          emoji={draft.emoji}
          avatarShape={draft.avatarShape}
          avatarColor={draft.avatarColor}
          onAvatar={(shape, color) => { set('avatarShape', shape); set('avatarColor', color) }}
          name={draft.name}
          onName={(name) => set('name', name)}
          color={draft.color}
          description={draft.description}
          onDescription={(description) => set('description', description)}
          systemPrompt={draft.systemPrompt}
          onSystemPrompt={(systemPrompt) => set('systemPrompt', systemPrompt)}
        />


        <section className="ob-bot-editor-section" aria-label={zh ? '对话模型' : 'Conversation model'}>
          <div className="ob-bot-editor-section-head"><h4>{zh ? '对话模型' : 'Conversation model'}</h4></div>
          <BotRuntimeFields
            backends={backends}
            configs={settings?.backends}
            backendId={runtime.backendId}
            modelId={runtime.modelId}
            thinking={runtime.thinking}
            onChange={chooseRuntime}
          />
        </section>
        <section className="ob-bot-editor-section" aria-label={zh ? '执行 Agent' : 'Execution agent'}>
        <div className="ob-bot-editor-section-head"><h4>{zh ? '执行 Agent' : 'Execution agent'}</h4><p>{zh ? '智能层按任务决定是否委派，简单消息由 Bot 直接回复。' : 'The intelligence layer decides when to delegate; the bot answers simple messages directly.'}</p></div>
        <BotRuntimeFields
          backends={backends}
          configs={settings?.backends}
          backendId={executionAgent.backendId}
          modelId={executionAgent.modelId}
          thinking={executionAgent.thinking}
          onChange={(choice) => set('executionAgent', { ...choice, ...(draft.executionAgent?.accessMode ? { accessMode: draft.executionAgent.accessMode } : {}) })}
        />
        <label className="ob-field"><span>{zh ? 'Agent 执行权限' : 'Agent execution access'}</span>
          <select className="ob-select" aria-label={zh ? 'Agent 执行权限' : 'Agent execution access'}
            value={draft.executionAgent?.accessMode ?? 'legacy'} disabled={saving || window.openbot.environment?.kind === 'browser'}
            onChange={event => set('executionAgent', { backendId: executionAgent.backendId, modelId: executionAgent.modelId, thinking: executionAgent.thinking, ...(event.target.value === 'full-access' ? { accessMode: 'full-access' as const } : {}) })}>
            <option value="legacy">{zh ? '保留原执行模式' : 'Keep existing execution mode'}</option>
            <option value="full-access" disabled={!supportsFullAccessExecution(executionAgent.backendId) || draft.computerTarget.kind !== 'local'}>{zh ? '独立完全授权' : 'Independent full access'}</option>
          </select>
        </label>
        <p className="ob-hint">{zh ? '完全访问仅用于新委派的独立 Agent，本机文件和命令不经过 Bot 的自然语言审核；托管限制、系统授权及已拒绝操作仍有效。信息不足时仍先由 Bot 处理澄清。旧任务不会自动升级，撤销会停止在途执行。仅对已接通的 CLI 生效。' : 'Full access applies to newly delegated independent Agents. Local files and commands are separate from Bot rule review; managed restrictions, OS consent and rejected actions remain binding. Clarifications still go to the Bot first. Old tasks are not upgraded; revoking access stops active execution. Applies only to connected CLI profiles.'}</p>
        <p className="ob-hint">{executionAccessDescription(executionAgent.backendId, zh)}</p>
        {!supportsExecutionDelegation(runtime.backendId) ? <p className="ob-hint" role="status">{zh ? '当前对话 CLI 暂不支持自动派发后台任务。可使用 Codex、Claude Code 或 OpenCode 作为对话 CLI；Kimi Code 仍可作为执行 Agent。' : 'This conversation CLI cannot delegate background work yet. Use Codex, Claude Code or OpenCode for conversation; Kimi Code can still be the execution agent.'}</p> : null}
        </section>
        {backendsError && !backendsLoading ? <p className="ob-hint">{backendsError}</p> : null}

        {bot ? <BotResourceLinks botId={bot.id} /> : null}

        <details className="ob-bot-editor-disclosure"><summary><span>{zh ? '记忆' : 'Memory'}</span><small>{zh ? '查看与管理' : 'View and manage'}</small></summary>{bot ? <BotMemory botId={bot.id} /> : <p className="ob-hint">{zh ? '保存 Bot 后即可管理记忆。' : 'Memory becomes available once the bot is saved.'}</p>}</details>
      </div>

      <footer className="ob-bot-editor-foot">
        {bot ? (
          confirmDelete ? (
            <span className="ob-bot-confirm" role="group" aria-labelledby={deleteLabelId} aria-busy={saving}>
              <small id={deleteLabelId}>{zh ? `删除「${bot.name}」？关联任务将停止，Bot 配置与记忆将删除；会话记录、工作文件和浏览器资料保留。` : `Delete “${bot.name}”? Related work stops and the bot configuration and memory are deleted. Chat history, working files and browser data stay.`}</small>
              <button type="button" className="ob-btn ob-btn-sm ob-btn-danger" disabled={saving} onClick={() => void remove()}>
                {saving ? (zh ? '删除中…' : 'Deleting…') : (zh ? '确认删除' : 'Delete permanently')}
              </button>
              <button ref={cancelDeleteButton} type="button" className="ob-btn ob-btn-sm" disabled={saving} onClick={() => setConfirmDelete(false)}>
                {zh ? '取消' : 'Cancel'}
              </button>
            </span>
          ) : (
            <button ref={deleteButton} type="button" className="ob-btn ob-btn-sm ob-btn-ghost" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={12} />
              {zh ? '删除' : 'Delete'}
            </button>
          )
        ) : (
          <span />
        )}
        <span className="ob-bot-editor-save">
          {!embedded ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => void close()}>
            {zh ? '取消' : 'Cancel'}
          </button> : null}
          <button
            type="button"
            className="ob-btn ob-btn-sm ob-btn-primary"
            onClick={() => void save()}
            disabled={!draft.name.trim() || saving || confirmDelete}
          >
            {saving && !confirmDelete ? (zh ? '保存中…' : 'Saving…') : bot ? (zh ? '保存' : 'Save changes') : (zh ? '创建 Bot' : 'Create bot')}
          </button>
        </span>
      </footer>
    </div>
  )
}
