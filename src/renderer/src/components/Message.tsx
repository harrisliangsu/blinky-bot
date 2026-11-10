import { memo, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { Attachment, Bot, Message } from '../../../shared/types'
import { isMessageQuote, MESSAGE_QUOTE_MIME } from '../../../shared/messageQuote'
import { clockTime } from '../lib/format'
import { copyText } from '../lib/clipboard'
import { reactToMessage, store, useMessage } from '../state'
import { BackendSetupLink } from './BackendSetupLink'
import { imagePreviewSrc } from './imageAttachments'
import { BotAvatar } from './BotAvatar'
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconReply, IconSmile, IconWarning } from './Icons'
import { setComposerQuote } from './useComposerDraft'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { ErrorBoundary } from './ErrorBoundary'
import { visibleAssistantText } from '../lib/messagePresentation'
import { VisualizationMarkdown } from './VisualizationMarkdown'
import { ApplicationNotice } from './ApplicationNotice'
import './Message.css'

interface MessageProps {
  id: string
  bots: Map<string, Bot>
  /** True when more than one bot is present, so authorship needs labelling. */
  multiBot: boolean
  expandSteps?: boolean
}

/**
 * Copies the code out of the frame whose Copy button was pressed. The lookup is
 * scoped to that button's own `.ob-code` figure, so it can never reach a
 * neighbouring block.
 */
function onMarkdownClick(e: MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement
  const button = target.closest<HTMLElement>('[data-copy-code]')
  if (!button) return
  const code = button.closest('.ob-code')?.querySelector('code')?.textContent ?? ''
  // A denied or unfocused clipboard must not be reported as a copy.
  copyText(code).then(
    () => {
      button.textContent = 'Copied'
      window.setTimeout(() => {
        button.textContent = 'Copy'
      }, 1200)
    },
    () => store.toast('The clipboard is not available, so nothing was copied.', 'error')
  )
}

function HandoffNote({ message, bots }: { message: Message; bots: Map<string, Bot> }): ReactNode {
  const from = message.botId ? bots.get(message.botId) : undefined
  const to = message.handoffTo ? bots.get(message.handoffTo) : undefined
  return (
    <div className="ob-handoff">
      <span className="ob-handoff-line" aria-hidden="true" />
      <span className="ob-handoff-body">
        <BotAvatar bot={from} size="sm" />
        <span className="ob-handoff-arrow" aria-hidden="true">
          →
        </span>
        <BotAvatar bot={to} size="sm" />
        <span className="ob-handoff-text">
          <strong>{from?.name ?? 'A bot'}</strong> handed over to <strong>{to?.name ?? 'another bot'}</strong>
          {message.content ? ` — ${message.content}` : ''}
        </span>
      </span>
      <span className="ob-handoff-line" aria-hidden="true" />
    </div>
  )
}

/**
 * The prose of a failed turn, with the failure detail taken out of it.
 *
 * A failed turn arrives with the same sentence in two places: the main process
 * appends the detail to `message.content` AND puts it in `message.error`, and
 * this bubble renders both — so the user read the identical explanation twice,
 * once as plain prose and once in the error treatment. The message shape is
 * relied on elsewhere and is left alone; only the rendering is deduplicated,
 * and the dedicated error treatment is the copy that survives.
 *
 * Both shapes the main process produces are covered: the detail alone when the
 * turn failed before writing anything, and `…content\n\n${detail}` when it
 * failed part-way through.
 */
function bodyWithoutError(content: string, error: string | undefined): string {
  const detail = error?.trim()
  if (!detail) return content
  const body = content.trimEnd()
  if (body === detail) return ''
  return body.endsWith(detail) ? body.slice(0, body.length - detail.length).trimEnd() : content
}

function CopyButton({ text }: { text: string }): ReactNode {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="ob-icon-btn ob-msg-copy"
      aria-label={done ? 'Message copied' : 'Copy message'}
      title={done ? 'Message copied' : 'Copy message'}
      onClick={() => {
        copyText(text).then(
          () => {
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          },
          () => store.toast('The clipboard is not available, so nothing was copied.', 'error')
        )
      }}
    >
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  )
}

function StoredImage({ attachment, sessionId, messageId }: { attachment: Attachment; sessionId: string; messageId: string }): ReactNode {
  const container = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(Boolean(attachment.data))
  const [data, setData] = useState<string | null>(attachment.data ?? null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const element = container.current
    if (!element || attachment.data) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    // Visibility gates the first read only. Clearing loaded data on exit
    // collapses the image, moves the observer targets, and can repeatedly
    // enter/exit them while Chromium is anchoring or scrolling to Latest.
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [attachment.data, attachment.dataRef])
  useEffect(() => {
    let active = true
    setData(attachment.data ?? null)
    setFailed(false)
    if (visible && !attachment.data && attachment.dataRef) {
      void window.openbot.sessions.attachment(sessionId, messageId, attachment.id).then((value) => {
        if (active) { setData(value); setFailed(!value) }
      }).catch(() => { if (active) setFailed(true) })
    }
    return () => { active = false }
  }, [attachment.data, attachment.dataRef, attachment.id, sessionId, messageId, visible])
  const src = imagePreviewSrc({ ...attachment, data: data ?? undefined })
  return <span ref={container} className="ob-msg-picture-container">{src ? <img className="ob-msg-picture" alt={attachment.name} src={src} /> : <span>{failed ? `图片无法读取：${attachment.name}` : attachment.name}</span>}</span>
}

// Message bubbles need the language, not every background task/activity update.
// A primitive snapshot lets React keep unchanged historical bubbles asleep.
function messageChinese(): boolean {
  const system = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language
  return resolveSettingsLang(store.getState().settings?.language, system) === 'zh-CN'
}

/**
 * One turn. Subscribes to its own message only, so a streaming token repaints
 * this bubble and nothing else.
 */
export const MessageView = memo(function MessageView({ id, bots, multiBot, expandSteps = false }: MessageProps): ReactNode {
  const zh = useSyncExternalStore(store.subscribe, messageChinese, messageChinese)
  const message = useMessage(id)
  const [showAttachments, setShowAttachments] = useState(false)
  const [showReactions, setShowReactions] = useState(false)
  const [showActions, setShowActions] = useState(false)

  if (!message) return null
  if (message.internal) return null
  if (message.role === 'system') return null

  /*
   * A tool message is raw output — a fetched page, a file, a command's stdout —
   * and it is already shown, escaped, inside its own ToolCallView. Falling
   * through to the assistant branch put it through the markdown renderer, the
   * app's one `dangerouslySetInnerHTML`. The sanitizer stops scripting, but a
   * fetched page could still paint a convincing fake OpenBOT frame inside the
   * transcript, attributed to a bot. The snapshot pane already returns null
   * here; the live transcript did not.
   */
  if (message.role === 'tool') return null
  if (message.uiOnly) return <ApplicationNotice message={message} zh={zh} />

  const bot = message.botId ? bots.get(message.botId) : undefined
  const isUser = message.role === 'user'
  const visibleText = isUser ? message.content : visibleAssistantText(message, true)
  const assistantBody = isUser ? '' : bodyWithoutError(visibleText, message.error)
  if (!isUser && !visibleText && !message.error) return null
  const attachments = message.attachments ?? []
  const pictures = attachments.filter((item) => item.kind === 'image' && (imagePreviewSrc(item) || item.dataRef))
  const quotes = attachments.filter(isMessageQuote)
  const otherAttachments = attachments.filter((item) => !isMessageQuote(item) && !pictures.some((picture) => picture.id === item.id))
  // Keep identity visible when multiple bots participate in the conversation.
  const showAuthor = !isUser && multiBot && bot !== undefined
  // The teammate whose message this one answers, when a handover happened.
  const answered = message.replyTo ? store.getMessage(message.replyTo) : null
  const repliedTo = answered?.botId ? bots.get(answered.botId) : undefined
  const activeReactions = Object.entries(message.reactions ?? {}).filter(([, people]) => people.length > 0)

  return (
    <article className={`ob-msg ob-msg-${isUser ? 'user' : 'assistant'}`} data-message-id={message.id} aria-label={isUser ? 'You' : bot?.name ?? 'Bot'}>
      {showAuthor ? (
        <header className="ob-msg-author">
          <span className="ob-msg-author-name">{bot?.name}</span>
          {/* Ties this turn to the teammate message that prompted it, so a
              back-and-forth reads as a thread rather than parallel monologues. */}
          {multiBot && repliedTo ? (
            <span className="ob-msg-replying">
              <span aria-hidden="true">↳</span> replying to <strong>{repliedTo.name}</strong>
            </span>
          ) : null}
        </header>
      ) : null}

      <div className="ob-msg-row">
      <div className="ob-msg-shell">
        {quotes.map((quote) => <div className="ob-msg-quote" key={quote.id} title={quote.data}><strong>{quote.name}</strong><span>{quote.data}</span></div>)}
        {isUser && message.content ? (
          <div className="ob-msg-bubble">{message.content}</div>
        ) : !isUser && assistantBody ? (
          <div className="ob-msg-answer">
            <ErrorBoundary label="This message could not be shown">
              <VisualizationMarkdown source={assistantBody} onClick={onMarkdownClick} />
            </ErrorBoundary>
          </div>
        ) : null}


        {pictures.length > 0 ? (
          <div className="ob-msg-pictures">
            {pictures.map((a) => <StoredImage key={a.id} attachment={a} sessionId={store.getState().currentSessionId ?? ''} messageId={message.id} />)}
          </div>
        ) : null}

        {otherAttachments.length > 0 ? (
          <div className="ob-msg-attachments">
            <button
              type="button"
              className="ob-msg-attach-toggle"
              onClick={() => setShowAttachments((v) => !v)}
              aria-expanded={showAttachments}
            >
              {showAttachments ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
              {otherAttachments.length} attachment{otherAttachments.length === 1 ? '' : 's'}
            </button>
            {showAttachments ? (
              <ul className="ob-msg-attach-list">
                {otherAttachments.map((a) => (
                  <li key={a.id} title={a.path ?? a.name}>
                    <span className="ob-msg-attach-kind">{a.kind}</span>
                    {a.name}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {message.error ? (
          <p className="ob-msg-error">
            <IconWarning size={12} />
            <span className="ob-msg-error-copy">
              {message.error}
              <BackendSetupLink text={message.error} />
            </span>
          </p>
        ) : null}
      </div>

      <div className={`ob-msg-action-group${showActions ? ' is-open' : ''}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setShowActions(false) } }}>
      <button type="button" className="ob-icon-btn ob-msg-more" aria-label={zh ? '更多消息操作' : 'More message actions'} aria-expanded={showActions} onClick={() => setShowActions(open => !open)}>···</button>
      <div className={`ob-msg-actions${activeReactions.length ? ' has-reactions' : ''}`} aria-label="Message actions" title={clockTime(message.createdAt)}>
        <CopyButton text={visibleText} />
        {!isUser && assistantBody ? <button type="button" className="ob-icon-btn" aria-label={zh ? '引用回复' : 'Quote reply'} title={zh ? '引用回复' : 'Quote reply'} onClick={() => {
          const sessionId = store.getState().currentSessionId
          if (!sessionId) return
          setComposerQuote(sessionId, { id: `quote-${message.id}`, kind: 'selection', name: bot?.name ?? 'Bot', mime: MESSAGE_QUOTE_MIME, data: assistantBody })
          document.querySelector<HTMLTextAreaElement>('#ob-prompt')?.focus()
        }}><IconReply size={16} /></button> : null}
        {!isUser ? <div className="ob-msg-reaction-control" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowReactions(false) }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setShowReactions(false) } }}>
          <button type="button" className="ob-icon-btn" aria-label="Add reaction" title="Add reaction" aria-expanded={showReactions} onClick={() => setShowReactions((open) => !open)}><IconSmile size={16} /></button>
          {showReactions ? <div className="ob-msg-reactions" role="group" aria-label="Reactions">
            {['👍', '❤️', '👀'].map((emoji) => {
              const people = message.reactions?.[emoji] ?? []
              return <button key={emoji} type="button" className={people.includes('You') ? 'is-active' : ''} aria-label={`React ${emoji}`} aria-pressed={people.includes('You')} title={people.join(', ') || `React ${emoji}`} onClick={() => { void reactToMessage(message.id, emoji); setShowReactions(false) }}>{emoji}{people.length ? ` ${people.length}` : ''}</button>
            })}
          </div> : null}
        </div> : null}
        {activeReactions.length ? <span className="ob-msg-reaction-summary">{activeReactions.map(([emoji, people]) => <span key={emoji} title={people.join(', ')}>{emoji}{people.length > 1 ? ` ${people.length}` : ''}</span>)}</span> : null}
      </div>
      </div>
      </div>
    </article>
  )
})
