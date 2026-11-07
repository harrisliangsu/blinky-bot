import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BoardCard, Bot } from '../../../shared/types'
import { openCardChat, removeCard, updateCard } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconChat, IconTrash } from './Icons'
import { FormDialog } from './FormDialog'
import './CardEditor.css'

interface CardEditorProps {
  card: BoardCard
  bots: Bot[]
  onClose: () => void
}

/** The card drawer: title, notes, who owns it, its chat, and delete. */
export function CardEditor({ card, bots, onClose }: CardEditorProps): ReactNode {
  const [title, setTitle] = useState(card.title)
  const [notes, setNotes] = useState(card.notes)
  const [botId, setBotId] = useState(card.botId ?? '')
  const [saving, setSaving] = useState(false)
  const original = useRef({ title: card.title, notes: card.notes, botId: card.botId ?? '' })
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setTitle(card.title)
    setNotes(card.notes)
    setBotId(card.botId ?? '')
    original.current = { title: card.title, notes: card.notes, botId: card.botId ?? '' }
    setConfirmDelete(false)
  }, [card.id])

  const dirty = title.trim() !== original.current.title || notes !== original.current.notes || botId !== original.current.botId
  const assigned = botId ? bots.find((b) => b.id === botId) : undefined

  const save = async (): Promise<void> => {
    if (!dirty || !title.trim() || saving) return
    setSaving(true)
    const patch: Partial<BoardCard> = {}
    if (title.trim() !== original.current.title) patch.title = title.trim()
    if (notes !== original.current.notes) patch.notes = notes
    if (botId !== original.current.botId) patch.botId = botId
    if (await updateCard(card.id, patch)) onClose()
    setSaving(false)
  }

  return (
    <FormDialog title="Edit card" size="md" onClose={() => { if (!saving) onClose() }}>
    <div className="ob-card-editor">

      <div className="ob-field">
        <label htmlFor="ob-card-title">Title</label>
        <input
          disabled={saving}
          id="ob-card-title"
          className="ob-input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
        />
      </div>

      <div className="ob-field">
        <label htmlFor="ob-card-notes">Notes</label>
        <textarea
          disabled={saving}
          id="ob-card-notes"
          className="ob-textarea"
          rows={7}
          value={notes}
          placeholder="Anything the bot should know before starting."
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="ob-field">
        <label htmlFor="ob-card-bot">Assigned bot</label>
        <div className="ob-card-bot">
          <BotAvatar bot={assigned} size="sm" />
          <select
            disabled={saving}
            id="ob-card-bot"
            className="ob-select"
            value={botId}
            // Empty string, not undefined: the store reads an absent key as
            // "leave it alone", so `undefined` could never unassign anyone.
            onChange={(e) => setBotId(e.target.value)}
          >
            <option value="">Nobody yet</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void openCardChat(card)}>
        <IconChat size={12} />
        {card.sessionId ? 'Go to the chat' : 'Open a chat from this card'}
      </button>
      <p className="ob-hint">
        {card.sessionId
          ? 'This card already has a conversation. Opening it switches the app to that chat.'
          : 'Starts a chat filed under this project, carrying the title and the assigned bot.'}
      </p>

      <footer className="ob-card-editor-foot">
        <button type="button" className="ob-btn ob-btn-sm" disabled={saving} onClick={onClose}>Cancel</button>
        {confirmDelete ? (
          <span className="ob-card-editor-actions">
            <button
              type="button"
              className="ob-btn ob-btn-sm ob-btn-danger"
              onClick={() => {
                void removeCard(card.id)
                onClose()
              }}
            >
              Delete card
            </button>
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="ob-btn ob-btn-sm ob-btn-ghost" onClick={() => setConfirmDelete(true)}>
            <IconTrash size={12} />
            Delete
          </button>
        )}
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={saving || !dirty || !title.trim()} onClick={() => void save()}>
          Save
        </button>
      </footer>
    </div>
    </FormDialog>
  )
}
