import { memo, useState, type MouseEvent, type ReactNode } from 'react'
import type { Bot, Message } from '../../../shared/types'
import { clockTime } from '../lib/format'
import { reactToMessage, store, useMessage } from '../state'
import { BackendSetupLink } from './BackendSetupLink'
import { BotAvatar } from './BotAvatar'
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconWarning } from './Icons'
import { ReasoningBlock } from './ReasoningBlock'
import { ErrorBoundary } from './ErrorBoundary'
import { ToolCallView } from './ToolCallView'
import { VisualizationMarkdown } from './VisualizationMarkdown'
import './Message.css'

interface MessageProps {
  id: string
  bots: Map<string, Bot>
  /** True when more than one bot is present, so authorship needs labelling. */
  multiBot: boolean
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
  navigator.clipboard.writeText(code).then(
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
      onClick={() => {
        navigator.clipboard.writeText(text).then(
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

/**
 * One turn. Subscribes to its own message only, so a streaming token repaints
 * this bubble and nothing else.
 */
export const MessageView = memo(function MessageView({ id, bots, multiBot }: MessageProps): ReactNode {
  const message = useMessage(id)
  const [showAttachments, setShowAttachments] = useState(false)

  if (!message) return null
  if (message.role === 'system' && message.handoffTo) return <HandoffNote message={message} bots={bots} />

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

  const bot = message.botId ? bots.get(message.botId) : undefined
  const isUser = message.role === 'user'
  const attachments = message.attachments ?? []
  const toolCalls = message.toolCalls ?? []
  const showAuthor = !isUser && multiBot && bot !== undefined
  // The teammate whose message this one answers, when a handover happened.
  const answered = message.replyTo ? store.getMessage(message.replyTo) : null
  const repliedTo = answered?.botId ? bots.get(answered.botId) : undefined

  return (
    <article className={`ob-msg ob-msg-${isUser ? 'user' : 'assistant'}`} aria-label={isUser ? 'You' : bot?.name ?? 'Assistant'}>
      {showAuthor ? (
        <header className="ob-msg-author">
          <BotAvatar bot={bot} size="sm" />
          <span className="ob-msg-author-name">{bot?.name}</span>
          {/* Ties this turn to the teammate message that prompted it, so a
              back-and-forth reads as a thread rather than parallel monologues. */}
          {repliedTo ? (
            <span className="ob-msg-replying">
              <span aria-hidden="true">↳</span> replying to <strong>{repliedTo.name}</strong>
            </span>
          ) : null}
          {message.model ? <span className="ob-msg-model">{message.model}</span> : null}
        </header>
      ) : null}

      <div className="ob-msg-shell">
        {message.reasoning !== undefined && !isUser ? (
          <ReasoningBlock text={message.reasoning} streaming={message.streaming === true && !message.content} />
        ) : null}

        {isUser ? (
          <div className="ob-msg-bubble">{message.content}</div>
        ) : (
          <ErrorBoundary label="This message could not be shown">
            <VisualizationMarkdown source={bodyWithoutError(message.content, message.error)} onClick={onMarkdownClick} />
          </ErrorBoundary>
        )}

        {message.streaming && !isUser ? <span className="ob-caret" aria-label="Still writing" /> : null}

        {toolCalls.length > 0 ? (
          <div className="ob-msg-tools">
            {toolCalls.map((call) => (
              <ToolCallView key={call.id} call={call} result={store.getToolResult(call.id)} />
            ))}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="ob-msg-attachments">
            <button
              type="button"
              className="ob-msg-attach-toggle"
              onClick={() => setShowAttachments((v) => !v)}
              aria-expanded={showAttachments}
            >
              {showAttachments ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
              {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
            </button>
            {showAttachments ? (
              <ul className="ob-msg-attach-list">
                {attachments.map((a) => (
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

      <footer className="ob-msg-foot">
        <time dateTime={new Date(message.createdAt).toISOString()}>{clockTime(message.createdAt)}</time>
        {!multiBot && message.model ? <span className="ob-msg-model">{message.model}</span> : null}
        <CopyButton text={message.content} />
        {!isUser ? <span className="ob-msg-reactions">
          {['👍', '❤️', '👀'].map((emoji) => {
            const people = message.reactions?.[emoji] ?? []
            return <button key={emoji} type="button" className={people.includes('You') ? 'is-active' : ''} title={people.join(', ') || `React ${emoji}`} onClick={() => void reactToMessage(message.id, emoji)}>{emoji}{people.length ? ` ${people.length}` : ''}</button>
          })}
        </span> : null}
      </footer>
    </article>
  )
})
