import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cx } from '../lib/format'
import { TRANSCRIPT_WINDOW, tailWindow } from '../lib/messageWindow'
import { useStickyScroll } from '../lib/stickyScroll'
import { clearPane, fetchPaneSession, focusPane, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { EarlierMessages } from './EarlierMessages'
import { IconClose } from './Icons'
import { MessageView } from './Message'
import { PaneChatBody, type PaneSnapshot } from './PaneChatBody'
import { WorkingPill } from './WorkingPill'
import './PaneChat.css'

interface PaneChatProps {
  sessionId: string
  /** Slot number, 0-based — panes are labelled by it so they can be named. */
  index: number
  focused: boolean
}

/**
 * One conversation inside a workspace pane.
 *
 * Only the FOCUSED pane is live: its chat is the app's current session, so the
 * message registry holds its messages and `MessageView` can subscribe to them
 * token by token. Every other pane renders a snapshot it fetched for itself, and
 * says so — a pane that quietly showed stale text would be worse than one that
 * admits it is a copy.
 */
export function PaneChat({ sessionId, index, focused }: PaneChatProps): ReactNode {
  const { bots, sessions, session, messageIds, currentSessionId, streaming, sessionLoading } = useAppState()

  const isCurrent = currentSessionId === sessionId
  const live = focused && isCurrent && session?.id === sessionId
  const opening = focused && isCurrent && !live && sessionLoading

  const summary = sessions.find((s) => s.id === sessionId)
  const [snapshot, setSnapshot] = useState<PaneSnapshot | null>(null)
  const [failed, setFailed] = useState(false)

  // Refetch when the pane goes cold, and whenever this chat's summary moves —
  // that is how a pane picks up what happened while another pane had focus.
  const stamp = summary ? `${summary.updatedAt}:${summary.messageCount}` : ''
  useEffect(() => {
    if (live || opening) return
    let cancelled = false
    setFailed(false)
    fetchPaneSession(sessionId)
      .then((loaded) => {
        if (!cancelled) setSnapshot({ id: sessionId, session: loaded })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, live, opening, stamp])

  const meta = live ? session : snapshot?.id === sessionId ? snapshot.session : null
  const title = meta?.title || summary?.title || 'Conversation'
  const botIds = meta?.botIds ?? summary?.botIds ?? []
  const activeBotId = meta?.activeBotId ?? botIds[0]
  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots])
  const participants = botIds.map((id) => botMap.get(id)).filter((b) => b !== undefined)
  const multiBot = botIds.length > 1

  const { scrollerRef, contentRef, onScroll, pin } = useStickyScroll()
  useEffect(() => {
    pin()
  }, [pin, live, sessionId, messageIds, snapshot])

  // The live pane pays the transcript's parsing cost, so it windows the same
  // way. `limit` rewinds with the chat: the page the reader opened belonged to
  // whatever conversation was in this slot before.
  const [limit, setLimit] = useState(TRANSCRIPT_WINDOW)
  useEffect(() => setLimit(TRANSCRIPT_WINDOW), [sessionId])
  const shown = tailWindow(messageIds, limit)

  return (
    <section
      className={cx('ob-pane', focused && 'is-focused')}
      aria-label={`Pane ${index + 1}: ${title}`}
      onMouseDownCapture={() => {
        if (!focused) focusPane(index)
      }}
    >
      <header className="ob-pane-head">
        <span className="ob-pane-bots">
          {participants.length > 0 ? (
            participants.map((bot) => <BotAvatar key={bot.id} bot={bot} size="sm" active={bot.id === activeBotId} />)
          ) : (
            <BotAvatar size="sm" />
          )}
        </span>

        <span className="ob-pane-title" title={title}>
          {title}
        </span>

        {focused ? (
          <span className="ob-pane-flag" title="This pane is live: the composer and the stream follow it">
            Live
          </span>
        ) : (
          <button
            type="button"
            className="ob-btn ob-btn-sm"
            onClick={() => focusPane(index)}
            aria-label={`Focus pane ${index + 1} and make it live`}
          >
            Focus
          </button>
        )}

        <button
          type="button"
          className="ob-icon-btn"
          onClick={() => clearPane(index)}
          aria-label={`Close pane ${index + 1} — pick another conversation for this slot`}
          title="Close this pane"
        >
          <IconClose size={12} />
        </button>
      </header>

      <div className="ob-pane-scroller" ref={scrollerRef} onScroll={onScroll} role="log" aria-live={live ? 'polite' : 'off'}>
        <div className="ob-pane-content" ref={contentRef}>
          {live ? (
            <>
              {messageIds.length === 0 ? <p className="ob-pane-empty">No messages yet — this pane is ready.</p> : null}
              <EarlierMessages hidden={shown.hidden} onShow={() => setLimit((n) => n + TRANSCRIPT_WINDOW)} />
              {shown.visible.map((id) => (
                <MessageView key={id} id={id} bots={botMap} multiBot={multiBot} />
              ))}
              {streaming && messageIds.length > 0 ? <WorkingPill size="md" /> : null}
            </>
          ) : (
            <PaneChatBody
              sessionId={sessionId}
              index={index}
              snapshot={snapshot}
              failed={failed}
              opening={opening}
              bots={botMap}
              multiBot={multiBot}
            />
          )}
        </div>
      </div>

      {!live && !opening ? (
        <footer className="ob-pane-foot">
          <button
            type="button"
            className="ob-pane-note"
            onClick={() => focusPane(index)}
            aria-label={`Focus pane ${index + 1} to continue this conversation`}
          >
            Snapshot — focus this pane to continue the conversation
          </button>
        </footer>
      ) : null}
    </section>
  )
}
