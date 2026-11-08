import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Attachment } from '../../../shared/types'
import type { MessageQueue } from '../../../shared/messageQueue'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { sendTurn, stopTurn, store, useAppState } from '../state'
import { ComposerAttachments, chooseAttachments } from './ComposerAttachments'
import { attachmentsFromImageFiles, filesFromTransfer } from './imageAttachments'
import { transferFiles } from '../remote/attachments'
import { REMOTE_MAX_ATTACHMENTS } from '../../../shared/remoteAttachments'
import { ComposerBar } from './ComposerBar'
import { ComposerMention, type MentionState } from './ComposerMention'
import { matchBots, mentionQuery } from './MentionPopup'
import { useVoiceInput } from './useVoiceInput'
import { useComposerDraft } from './useComposerDraft'
import { IconClose } from './Icons'
import { useBotChinese } from './BotUiLanguage'
import './Composer.css'

const MAX_HEIGHT = 320

/** Prompt input and run controls. The Bot’s CLI and model come from Settings. */
export function Composer(): ReactNode {
  const chat = useSettingsCopy().chat
  const zh = useBotChinese()
  const { session, bots, settings, streaming, bootError } = useAppState()
  const [queue, setQueue] = useState<MessageQueue | null>(null)
  const { text, setText, attachments, setAttachments, quote, setQuote } = useComposerDraft(session?.id)
  const [attaching, setAttaching] = useState(false)
  const [dragging, setDragging] = useState(false)
  // `@` picker: which mention the caret is inside, if any.
  const [mention, setMention] = useState<MentionState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const voice = useVoiceInput(session?.id, settings?.voiceLanguage ?? 'system', zh, (spoken) => {
    const el = textareaRef.current
    setText((current) => {
      const at = el && el.value === current ? (el.selectionStart ?? current.length) : current.length
      const end = el && el.value === current ? (el.selectionEnd ?? at) : at
      const before = current.slice(0, at), after = current.slice(end)
      return `${before}${before && !/\s$/.test(before) ? ' ' : ''}${spoken}${after && !/^\s/.test(after) ? ' ' : ''}${after}`
    })
    textareaRef.current?.focus({ preventScroll: true })
  })


  useEffect(() => {
    const id = session?.id
    setQueue(null)
    if (!id) return
    let active = true
    let updated = false
    void window.openbot.agent.queue(id).then((value) => { if (active && !updated) setQueue(value) })
    const unsubscribe = window.openbot.on((event) => {
      if (event.type === 'message-queue-updated' && event.queue.sessionId === id) {
        updated = true
        setQueue(event.queue)
      }
    })
    return () => { active = false; unsubscribe() }
  }, [session?.id])

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    let width = 0
    const observer = new ResizeObserver(() => {
      if (width === el.clientWidth) return
      width = el.clientWidth; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const readOnly = window.openbot.environment?.kind === 'browser' && window.openbot.environment.permission === 'view'
  const canSend = !readOnly && !attaching && (text.trim().length > 0 || attachments.length > 0) && bootError === null
  // Only bots in this session can be addressed — mentioning an absent bot does nothing.
  const mentionable = bots.filter((b) => session?.botIds.includes(b.id))
  // The picker is "open" only when it has something to offer. `@` followed by
  // anything unmatched is just text, and must not go on owning Enter.
  const picking = mention !== null && matchBots(mentionable, mention.query).length > 0

  const submit = useCallback(() => {
    if (!canSend || submitting.current) return
    submitting.current = true
    voice.cancel()
    const sent = text
    const files = quote ? [quote, ...attachments] : attachments
    setText('')
    setAttachments([])
    setQuote(null)
    setMention(null)
    window.dispatchEvent(new CustomEvent('openbot:chat-sent', { detail: session?.id }))
    /*
     * A send that never reached the agent hands its text back. The local echo
     * is dropped on that path (see state/conversation.ts), so without this the
     * message would vanish from the transcript AND from the box the user typed
     * it in. Only refill an empty composer: whatever was typed since is newer.
     */
    const current = store.getState()
    const working = current.currentSessionId === session?.id && current.streaming
    let action: Promise<boolean>
    const backgroundWorking = current.tasks.some((task) => task.sourceSessionId === session?.id && (task.status === 'queued' || task.status === 'running'))
    const stopRequest = /^(?:停|停止|停下|停止当前任务|停止当前工作|stop|stop now)[。.!！\s]*$/i.test(sent.trim())
    if (session && !files.length && stopRequest && (working || backgroundWorking)) {
      action = stopTurn(sent.trim())
    } else if (session && (working || (queue?.items.length ?? 0) > 0)) {
      const localId = store.nextId('local')
      store.optimistic.add(localId)
      store.appendMessage({ id: localId, role: 'user', content: sent.trim(), attachments: files, createdAt: Date.now() })
      action = window.openbot.agent.enqueue(session.id, sent, files).then((result) => {
        if (!result) store.toast(chat.queueFailed, 'error')
        return Boolean(result)
      }).finally(() => {
        if (store.optimistic.delete(localId)) store.dropMessage(localId)
      })
    } else action = sendTurn(sent, files.length ? files : undefined)
    // The message was captured synchronously. Do not hold the input lock while
    // the main process acknowledges the turn; later messages can be queued.
    submitting.current = false
    void action.catch(() => false).then((ok) => {
      if (ok) return
      setText((current) => current ? `${sent}\n${current}` : sent)
      setAttachments((current) => [...attachments, ...current])
      if (quote) setQuote((current) => current ?? quote)
    })
  }, [canSend, text, attachments, quote, session, queue, chat.queueFailed, setQuote])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the @ picker is open it owns Enter/Tab/arrows for choosing a bot.
    if (picking && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      const modified = e.metaKey || e.ctrlKey
      const shortcut = settings?.sendShortcut ?? 'enter'
      if (shortcut === 'mod-enter' && !modified) return
      e.preventDefault()
      submit()
    }
  }

  const addAttachments = (chosen: Attachment[]): void => {
    setAttachments(previous => {
      if (previous.length + chosen.length > REMOTE_MAX_ATTACHMENTS) { store.toast(zh ? '最多添加 12 个附件。' : 'Add up to 12 attachments.', 'error'); return previous }
      return [...previous, ...chosen]
    })
  }
  const attach = async (): Promise<void> => {
    if (attaching || readOnly) return
    setAttaching(true)
    try { addAttachments(await chooseAttachments()) }
    catch (error) { store.toast(error instanceof Error ? error.message : '附件未能添加。 / Attachment failed.', 'error') }
    finally { setAttaching(false) }
  }

  const takeImages = async (data: DataTransfer | null): Promise<void> => {
    if (!data || readOnly) return
    if (window.openbot.dialog.importAttachments) {
      setAttaching(true)
      try { addAttachments(await window.openbot.dialog.importAttachments(transferFiles(data))) }
      catch (error) { store.toast(error instanceof Error ? error.message : '附件未能添加。 / Attachment failed.', 'error') }
      finally { setAttaching(false) }
      return
    }
    const { attachments: next, skipped } = await attachmentsFromImageFiles(filesFromTransfer(data))
    if (skipped > 0) store.toast(chat.imageTooBig, 'error')
    if (next.length === 0) return
    addAttachments(next)
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = filesFromTransfer(e.clipboardData)
    if (images.length === 0 && !(window.openbot.dialog.importAttachments && transferFiles(e.clipboardData).length)) return
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
      {attaching ? <p className="ob-hint" role="status">{zh ? '正在添加附件…' : 'Adding attachments…'}</p> : null}
      <ComposerAttachments
        attachments={attachments}
        onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
      />

      <div className="ob-composer-box">
        {quote ? <div className="ob-composer-quote"><div><strong>{zh ? `引用 ${quote.name}` : `Quoting ${quote.name}`}</strong><span>{quote.data}</span></div><button type="button" className="ob-icon-btn" aria-label={zh ? '取消引用' : 'Remove quote'} title={zh ? '取消引用' : 'Remove quote'} onClick={() => setQuote(null)}><IconClose size={12} /></button></div> : null}
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
        <ComposerBar onAttach={() => void attach()} attaching={attaching} listening={voice.listening} voiceBusy={voice.busy}
          onToggleVoice={voice.toggle} blocked={readOnly || bootError !== null || !session} canSend={canSend} onSend={submit}>
        <textarea
          id="ob-prompt"
          ref={textareaRef}
          className="ob-composer-input"
          rows={1}
          value={text}
          placeholder={readOnly ? (zh ? '此设备仅可查看' : 'This device has view-only access') : chat.placeholder}
          readOnly={readOnly}
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

        </ComposerBar>
        {voice.busy || voice.error ? <div className="ob-composer-voice">
          <span role={voice.error ? 'alert' : 'status'}>{voice.error || (voice.state === 'starting' ? (zh ? '正在准备本地语音输入…' : 'Preparing on-device dictation…') : voice.state === 'stopping' ? (zh ? '正在完成识别…' : 'Finishing recognition…') : (zh ? '正在聆听，点击麦克风结束' : 'Listening. Click the microphone to finish.'))}{voice.interim ? ` · ${voice.interim}` : ''}</span>
          {voice.busy ? <button type="button" className="ob-icon-btn" onClick={voice.cancel} aria-label={zh ? '取消语音输入' : 'Cancel voice input'}><IconClose size={13} /></button> : null}
        </div> : null}

      </div>
    </div>
  )
}
