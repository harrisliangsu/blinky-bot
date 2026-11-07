import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { memoryConflictPeers, memoryKind, memorySourceBotId, type MemoryKind } from '../../../main/agent/memoryRecall'
import { relativeTime } from '../lib/format'
import { loadMemory, useAppState } from '../state'
import { writeMemory, forgetMemory } from './memoryProtocol'
import { IconPlus, IconTrash } from './Icons'
import { useBotChinese } from './BotUiLanguage'
import { FormDialog } from './FormDialog'
import './BotMemory.css'

function memoryTime(timestamp: number, zh: boolean): string {
  if (!zh) return relativeTime(timestamp)
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

interface BotMemoryProps {
  botId: string
}

/** What the bot remembers, with a way to add and forget entries. */
export function BotMemory({ botId }: BotMemoryProps): ReactNode {
  const zh = useBotChinese()
  const { memories, bots } = useAppState()
  const [text, setText] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shared, setShared] = useState(false)
  const [kind, setKind] = useState<MemoryKind>('profile')
  const activeBot = useRef(botId)
  activeBot.current = botId
  const entries = memories[botId]
  const groups = useMemo(() => (['profile', 'journal', 'note'] as const).map(value => ({ kind: value, entries: [...(entries ?? [])].filter(entry => memoryKind(entry) === value).sort((a, b) => b.createdAt - a.createdAt) })), [entries])

  useEffect(() => {
    void loadMemory(botId); setEditing(undefined); setEditorOpen(false); setText(''); setError(''); setShared(false); setKind('profile')
    const timer = setInterval(() => void loadMemory(botId), 1500)
    return () => clearInterval(timer)
  }, [botId])

  const submit = (): void => {
    if (!text.trim() || busy) return
    const submitted = text
    setBusy(true); setError('')
    void writeMemory(botId, submitted, editing, shared, kind).then(async saved => {
      if (!saved) throw new Error('记忆未能保存，请检查内容和本地存储。')
      for (const id of Object.keys(memories)) await loadMemory(id)
      if (activeBot.current !== botId) await loadMemory(activeBot.current)
      if (activeBot.current === botId) { setText(''); setEditing(undefined); setEditorOpen(false) }
    }).catch(e => setError(String(e.message ?? e))).finally(() => setBusy(false))
  }

  return (
    <section className="ob-memory">
      <h4 className="ob-label">{zh ? '已保存的记忆' : 'Saved memories'}</h4>
      {!editorOpen && error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { if (editing) { setText(''); setKind('profile'); setShared(false) }; setEditing(undefined); setError(''); setEditorOpen(true) }}>{zh ? '添加记忆' : 'Add memory'}</button>
      {editorOpen ? <FormDialog title={editing ? (zh ? '更正记忆' : 'Correct memory') : (zh ? '添加记忆' : 'Add memory')} size="sm" fallbackFocus=".ob-memory > button" onClose={() => { if (!busy) setEditorOpen(false) }}>
      <div className="ob-memory-add">
        <input
          className="ob-input"
          disabled={busy}
          value={text}
          placeholder={zh ? '添加这位 Bot 需要记住的事' : 'Something this bot should remember'}
          aria-label={zh ? '新记忆' : 'New memory'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button type="button" className="ob-icon-btn" onClick={submit} aria-label={editing ? '保存更正' : zh ? '添加记忆' : 'Add memory'} disabled={busy || !text.trim()}>
          <IconPlus size={12} />
        </button>
      </div>
      <label className="ob-memory-kind">{zh ? '记忆类型' : 'Memory type'} <select className="ob-select" aria-label={zh ? '记忆类型' : 'Memory type'} value={kind} disabled={busy} onChange={event => setKind(event.target.value as MemoryKind)}>
        <option value="profile">{zh ? '档案 · 长期偏好' : 'Profile · lasting preferences'}</option>
        <option value="journal">{zh ? '日记 · 带日期的记录' : 'Journal · dated records'}</option>
        <option value="note">{zh ? '其他记忆' : 'Other notes'}</option>
      </select></label>
      {!editing ? <label className="ob-hint"><input type="checkbox" disabled={busy} aria-label="所有 Bot 共享" checked={shared} onChange={event => setShared(event.target.checked)} />所有 Bot 共享</label> : null}

        {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setEditorOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
      </FormDialog> : null}

      {entries === undefined ? (
        <p className="ob-hint">{zh ? '正在加载记忆…' : 'Loading memory…'}</p>
      ) : entries.length === 0 ? (
        <p className="ob-hint">{zh ? '还没有保存记忆。' : 'Nothing remembered yet.'}</p>
      ) : (
        <div className="ob-memory-groups">{groups.map(group => <section className="ob-memory-group" key={group.kind} aria-label={group.kind === 'profile' ? (zh ? '档案' : 'Profile') : group.kind === 'journal' ? (zh ? '日记' : 'Journal') : (zh ? '其他记忆' : 'Other notes')}>
          <h5>{group.kind === 'profile' ? (zh ? '档案' : 'Profile') : group.kind === 'journal' ? (zh ? '日记' : 'Journal') : (zh ? '其他记忆' : 'Other notes')} <span>{group.entries.length}</span></h5>
          {!group.entries.length ? <p className="ob-hint">{zh ? '暂无记录' : 'No entries'}</p> : <ul className="ob-memory-list">
          {group.entries.map((entry) => (
            <li key={entry.id} className="ob-memory-item">
              <span className="ob-memory-text">{entry.text}</span>
              {entry.botId === '__blinky_user_preferences__' ? <span className="ob-memory-provenance">{zh ? '所有 Bot 共享' : 'Shared across Bots'} · {memorySourceBotId(entry) ? (bots.find(bot => bot.id === memorySourceBotId(entry))?.name ?? (zh ? '原 Bot 已移除' : 'Source Bot removed')) : (zh ? '来源未记录' : 'Source not recorded')}</span> : null}
              {memoryConflictPeers(entry, entries).length ? <span className="ob-memory-conflict" role="note">{zh ? '同主题共享档案存在不同记录，请核对日期与来源；不会自动合并。' : 'Shared profile records with this subject differ. Review their dates and sources; they are not merged automatically.'}</span> : null}
              <span className="ob-memory-meta">
                <span className="ob-pill">{entry.tags?.includes('user-preference') ? (zh ? '共享偏好' : 'Shared preference') : zh ? ({ user: '用户添加', run: '对话记忆', exchange: '协作记忆' }[entry.source] ?? entry.source) : entry.source}</span>
                <span>{memoryTime(entry.createdAt, zh)}</span>
                <button type="button" className="ob-btn ob-btn-sm" disabled={busy} aria-label={`更正记忆：${entry.text}`} onClick={() => { setEditing(entry.id); setText(entry.text); setKind(memoryKind(entry)); setError(''); setEditorOpen(true) }}>更正</button>
                <button
                  type="button"
                  className="ob-icon-btn"
                  aria-label={entry.tags?.includes('user-preference') ? (zh ? '从所有 Bot 中移除此偏好' : 'Forget this preference for all bots') : (zh ? '移除此记忆' : 'Forget this entry')}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true); setError('')
                    void forgetMemory(botId, entry.id).then(async removed => {
                      if (!removed) throw new Error('删除未确认，请刷新后检查，记忆未从界面隐藏。')
                      for (const id of Object.keys(memories)) await loadMemory(id)
                    }).catch(e => setError(String(e.message ?? e))).finally(() => setBusy(false))
                  }}
                >
                  <IconTrash size={11} />
                </button>
              </span>
            </li>
          ))}
          </ul>}
        </section>)}</div>
      )}
    </section>
  )
}
