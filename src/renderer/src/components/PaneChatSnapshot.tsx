import { type ReactNode } from 'react'
import type { Bot, Message } from '../../../shared/types'
import { clockTime } from '../lib/format'
import { BotAvatar } from './BotAvatar'
import { VisualizationMarkdown } from './VisualizationMarkdown'

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
  return (
    <>
      {messages.map((message) => (
        <SnapshotMessage key={message.id} message={message} bots={bots} multiBot={multiBot} />
      ))}
    </>
  )
}

function SnapshotMessage({ message, bots, multiBot }: { message: Message; bots: Map<string, Bot>; multiBot: boolean }): ReactNode {
  if (message.role === 'system' && message.handoffTo) {
    const from = message.botId ? bots.get(message.botId) : undefined
    const to = bots.get(message.handoffTo)
    return (
      <p className="ob-pane-handoff">
        <BotAvatar bot={from} size="sm" />
        <span aria-hidden="true">→</span>
        <BotAvatar bot={to} size="sm" />
        <span>
          {from?.name ?? 'A bot'} handed over to {to?.name ?? 'another bot'}
        </span>
      </p>
    )
  }
  if (message.role === 'system' || message.role === 'tool') return null

  const isUser = message.role === 'user'
  const bot = message.botId ? bots.get(message.botId) : undefined
  const toolCalls = message.toolCalls ?? []

  return (
    <article className={`ob-pane-msg ob-pane-msg-${isUser ? 'user' : 'assistant'}`} aria-label={isUser ? 'You' : bot?.name ?? 'Bot'}>
      {!isUser && multiBot && bot ? (
        <header className="ob-pane-msg-author">
          <BotAvatar bot={bot} size="sm" />
          <span>{bot.name}</span>
        </header>
      ) : null}

      {isUser ? <div className="ob-pane-bubble">{message.content}</div> : <VisualizationMarkdown source={message.content} />}

      {/* Tool detail stays collapsed to a count: a quarter-width pane has no
          room for full call frames, and the focused pane shows them in full. */}
      {toolCalls.length > 0 ? (
        <p className="ob-pane-tools">
          {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
          <span className="ob-pane-tool-names">{toolCalls.map((call) => call.name).join(', ')}</span>
        </p>
      ) : null}

      {message.error ? <p className="ob-pane-msg-error">{message.error}</p> : null}

      <footer className="ob-pane-msg-foot">
        <time dateTime={new Date(message.createdAt).toISOString()}>{clockTime(message.createdAt)}</time>
      </footer>
    </article>
  )
}
