import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Attachment } from '../../../shared/types'
import { sendTurn, updateBot, updateSettings, useAppState } from '../state'
import { ComposerAttachments, chooseAttachments } from './ComposerAttachments'
import { ComposerBar } from './ComposerBar'
import { ComposerContext } from './ComposerContext'
import { ComposerMention, type MentionState } from './ComposerMention'
import { matchBots, mentionQuery } from './MentionPopup'
import { useVoiceInput } from './useVoiceInput'
import './Composer.css'

const MAX_HEIGHT = 320

/** Prompt input, mode switcher, model picker and run controls. */
export function Composer(): ReactNode {
  const { session, bots, backends, backendsLoading, backendsError, settings, streaming, bootError } = useAppState()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
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

  const activeBot = bots.find((b) => b.id === session?.activeBotId) ?? bots.find((b) => b.id === session?.botIds[0])
  const backendId = activeBot?.backendId ?? settings?.defaultBackendId ?? ''
  const modelId = activeBot?.modelId ?? settings?.defaultModelId ?? ''
  const mode = session?.mode ?? settings?.defaultMode ?? 'agent'
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

  const chooseModel = (nextBackendId: string, nextModelId: string): void => {
    if (activeBot) void updateBot(activeBot.id, { backendId: nextBackendId, modelId: nextModelId })
    else void updateSettings({ defaultBackendId: nextBackendId, defaultModelId: nextModelId })
  }

  return (
    <div className="ob-composer">
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
          placeholder={streaming ? 'Running — Esc to stop' : voice.interim ? voice.interim : 'Ask anything…'}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            const caret = e.target.selectionStart ?? next.length
            const found = mentionQuery(next, caret)
            setMention(found ? { ...found, caret } : null)
          }}
          onKeyDown={onKeyDown}
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
          mode={mode}
          hasSession={Boolean(session)}
          backends={backends}
          backendId={backendId}
          modelId={modelId}
          backendsLoading={backendsLoading}
          backendsError={backendsError}
          onChooseModel={chooseModel}
          streaming={streaming}
          blocked={bootError !== null}
          canSend={canSend}
          onSend={submit}
        />
      </div>

      {/*
        Working context sits under the composer, where the reference apps put it:
        it is a property of the next message, so it belongs beside the input
        rather than in the window chrome where it read as a static label.
      */}
      {session ? <ComposerContext cwd={session.cwd} /> : null}
    </div>
  )
}
