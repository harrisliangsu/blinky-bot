import { type ReactNode } from 'react'
import type { Bot, Message } from '../../../shared/types'
import { isMessageQuote } from '../../../shared/messageQuote'
import { clockTime } from '../lib/format'
import { VisualizationMarkdown } from './VisualizationMarkdown'
import { visibleAssistantText } from '../lib/messagePresentation'
import { ApplicationNotice } from './ApplicationNotice'
import { useBotChinese } from './BotUiLanguage'

interface SnapshotProps {
  messages: Message[]
  bots: Map<string, Bot>
  /** More than one bot in the chat, so authorship needs labelling. */
  multiBot: boolean
}

/**
 * A chat that is not the live one.
 *
 * `MessageView` reads from the store's message registry, and that registry only
 * ever holds the CURRENT session — so an unfocused pane cannot use it. This is
 * the read-only stand-in: the same shapes, none of the subscriptions, and no
 * streaming caret, because nothing here can be streaming by definition.
 */
export function PaneChatSnapshot({ messages, bots, multiBot }: SnapshotProps): ReactNode {
  const zh = useBotChinese()
  return (
    <>
      {messages.map((message) => (
        <SnapshotMessage key={message.id} message={message} bots={bots} multiBot={multiBot} zh={zh} />
      ))}
    </>
  )
}

function SnapshotMessage({ message, bots, multiBot, zh }: { message: Message; bots: Map<string, Bot>; multiBot: boolean; zh: boolean }): ReactNode {
  if (message.internal || message.role === 'system' || message.role === 'tool') return null
  if (message.uiOnly) return <ApplicationNotice message={message} zh={zh} />

  const isUser = message.role === 'user'
  const bot = message.botId ? bots.get(message.botId) : undefined
  const visibleText = isUser ? message.content : visibleAssistantText(message)
  if (!isUser && !visibleText && !message.error) return null

  return (
    <article className={`ob-pane-msg ob-pane-msg-${isUser ? 'user' : 'assistant'}`} aria-label={isUser ? 'You' : bot?.name ?? 'Bot'}>
      {!isUser && multiBot && bot ? (
        <header className="ob-pane-msg-author">
          <span>{bot.name}</span>
        </header>
      ) : null}

      {isUser ? message.attachments?.filter(isMessageQuote).map((quote) => <div className="ob-msg-quote" key={quote.id} title={quote.data}><strong>{quote.name}</strong><span>{quote.data}</span></div>) : null}

      {isUser ? <div className="ob-pane-bubble">{message.content}</div> : visibleText ? (
        <div className="ob-pane-answer"><VisualizationMarkdown source={visibleText} /></div>
      ) : null}

      {message.error ? <p className="ob-pane-msg-error">{message.error}</p> : null}

      <footer className="ob-pane-msg-foot">
        <time dateTime={new Date(message.createdAt).toISOString()}>{clockTime(message.createdAt)}</time>
      </footer>
    </article>
  )
}
