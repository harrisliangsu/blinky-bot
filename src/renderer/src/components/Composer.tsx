import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Attachment } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { sendTurn, store, useAppState } from '../state'
import { ComposerAttachments, chooseAttachments } from './ComposerAttachments'
import { attachmentsFromImageFiles, filesFromTransfer } from './imageAttachments'
import { ComposerBar } from './ComposerBar'
import { ComposerMention, type MentionState } from './ComposerMention'
import { matchBots, mentionQuery } from './MentionPopup'
import { useVoiceInput } from './useVoiceInput'
import './Composer.css'

const MAX_HEIGHT = 320

/** Prompt input and run controls. The Bot’s CLI and model come from Settings. */
export function Composer(): ReactNode {
  const chat = useSettingsCopy().chat
  const { session, bots, settings, streaming, bootError } = useAppState()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const voice = useVoiceInput((spoken) =>
    setText((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${spoken.trim()} `)
  )
  // `@` picker: which mention the caret is inside, if any.
  const [mention, setMention] = useState<MentionState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !streaming && bootError === null
  // Only bots in this session can be addressed — mentioning an absent bot does nothing.
  const mentionable = bots.filter((b) => session?.botIds.includes(b.id))
  // The picker is "open" only when it has something to offer. `@` followed by
  // anything unmatched is just text, and must not go on owning Enter.
  const picking = mention !== null && matchBots(mentionable, mention.query).length > 0

  const submit = useCallback(() => {
    if (!canSend) return
    const sent = text
    const files = attachments
    setText('')
    setAttachments([])
    setMention(null)
    /*
     * A send that never reached the agent hands its text back. The local echo
     * is dropped on that path (see state/conversation.ts), so without this the
     * message would vanish from the transcript AND from the box the user typed
     * it in. Only refill an empty composer: whatever was typed since is newer.
     */
    void sendTurn(sent, files.length ? files : undefined).then((ok) => {
      if (ok) return
      setText((current) => (current === '' ? sent : current))
      setAttachments((current) => (current.length === 0 ? files : current))
    })
  }, [canSend, text, attachments])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the @ picker is open it owns Enter/Tab/arrows for choosing a bot.
    if (picking && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      const modified = e.metaKey || e.ctrlKey
      const shortcut = settings?.sendShortcut ?? 'enter'
      if (shortcut === 'mod-enter' ? !modified : modified) return
      e.preventDefault()
      submit()
    }
  }

  const attach = async (): Promise<void> => {
    const chosen = await chooseAttachments()
    if (chosen.length === 0) return
    setAttachments((prev) => [...prev, ...chosen])
  }

  const takeImages = async (data: DataTransfer | null): Promise<void> => {
    if (!data) return
    const { attachments: next, skipped } = await attachmentsFromImageFiles(filesFromTransfer(data))
    if (skipped > 0) store.toast(chat.imageTooBig, 'error')
    if (next.length === 0) return
    setAttachments((prev) => [...prev, ...next])
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = filesFromTransfer(e.clipboardData)
    if (images.length === 0) return
    e.preventDefault()
    const pasted = e.clipboardData.getData('text/plain')
    if (pasted) {
      const el = e.currentTarget
      const start = el.selectionStart ?? text.length
      const end = el.selectionEnd ?? start
      const next = `${text.slice(0, start)}${pasted}${text.slice(end)}`
      setText(next)
      const caret = start + pasted.length
      const found = mentionQuery(next, caret)
      setMention(found ? { ...found, caret } : null)
    }
    void takeImages(e.clipboardData)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragging(false)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragging(false)
    void takeImages(e.dataTransfer)
  }

  return (
    <div
      className={`ob-composer${dragging ? ' is-drop' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ComposerAttachments
        attachments={attachments}
        onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
      />

      <div className="ob-composer-box">
        {mention ? (
          /* Renders nothing when no bot matches — `picking` tracks that, so the
             keys it claims are released the moment the list empties. */
          <ComposerMention
            bots={mentionable}
            mention={mention}
            text={text}
            input={textareaRef}
            onPicked={(next) => {
              setText(next)
              setMention(null)
            }}
            onDismiss={() => setMention(null)}
          />
        ) : null}
        <label className="ob-sr-only" htmlFor="ob-prompt">
          Message
        </label>
        <textarea
          id="ob-prompt"
          ref={textareaRef}
          className="ob-composer-input"
          rows={1}
          value={text}
          placeholder={streaming ? chat.running : voice.interim ? voice.interim : chat.placeholder}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            const caret = e.target.selectionStart ?? next.length
            const found = mentionQuery(next, caret)
            setMention(found ? { ...found, caret } : null)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          /* Leaving the input closes the picker: it listens for keys on the
             window, and must not claim Enter in a panel elsewhere. Choosing an
             item uses mousedown + preventDefault, so focus never leaves. */
          onBlur={() => setMention(null)}
          disabled={bootError !== null}
          spellCheck
        />

        <ComposerBar
          onAttach={() => void attach()}
          listening={voice.listening}
          onToggleVoice={voice.toggle}
          streaming={streaming}
          blocked={bootError !== null}
          canSend={canSend}
          onSend={submit}
        />
      </div>
    </div>
  )
}
