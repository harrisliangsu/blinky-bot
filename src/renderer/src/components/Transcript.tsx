import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { TRANSCRIPT_WINDOW, tailWindow } from '../lib/messageWindow'
import { showsJump, useStickyScroll } from '../lib/stickyScroll'
import { store, useAppState } from '../state'
import { BackendSetupLink } from './BackendSetupLink'
import { EarlierMessages } from './EarlierMessages'
import { IconArrowDown, IconSpinner, IconWarning } from './Icons'
import { MessageView } from './Message'
import { WorkingPill } from './WorkingPill'
import './Transcript.css'

function EmptyTranscript({ hasSession }: { hasSession: boolean }): ReactNode {
  return (
    <div className="ob-transcript-empty">
      <h2 className="ob-empty-title">{hasSession ? 'Ready when you are' : 'What should we work on?'}</h2>
      <p className="ob-empty-body">
        Ask a question, describe a task, or point a bot at a folder. Everything runs on this machine.
      </p>
    </div>
  )
}

/**
 * The message list. Sticks to the bottom while new content streams in, unless
 * the reader has scrolled up — then it stays put and offers a jump button.
 *
 * Only the newest turns are rendered; see `lib/messageWindow` for why.
 */
export function Transcript(): ReactNode {
  const { messageIds, bots, session, sessionLoading, runError, streaming } = useAppState()
  const [showJump, setShowJump] = useState(false)
  const [limit, setLimit] = useState(TRANSCRIPT_WINDOW)

  const { scrollerRef, contentRef, onScroll, pin, jump } = useStickyScroll((geometry) =>
    setShowJump(showsJump(geometry))
  )

  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots])
  const multiBot = (session?.botIds.length ?? 0) > 1
  const { visible, hidden } = tailWindow(messageIds, limit)

  const toBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      jump(behavior)
      setShowJump(false)
    },
    [jump]
  )

  // `messageIds`, not the windowed slice: a full window keeps the same length
  // when a turn arrives, and the list must still follow it down.
  useEffect(() => {
    pin()
  }, [pin, messageIds])

  useEffect(() => {
    // A different chat starts at its newest turn, and rewinds the window: the
    // "show earlier" the reader opened belonged to the conversation they left.
    setLimit(TRANSCRIPT_WINDOW)
    toBottom()
  }, [session?.id, toBottom])

  if (sessionLoading) {
    return (
      <div className="ob-transcript" aria-busy="true">
        <div className="ob-transcript-status">
          <IconSpinner />
          Opening conversation…
        </div>
      </div>
    )
  }

  return (
    <div className="ob-transcript">
      <div className="ob-transcript-scroller" ref={scrollerRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="Conversation">
        <div className="ob-transcript-content" ref={contentRef}>
          {messageIds.length === 0 && !runError ? <EmptyTranscript hasSession={session !== null} /> : null}

          <EarlierMessages hidden={hidden} onShow={() => setLimit((n) => n + TRANSCRIPT_WINDOW)} />

          {visible.map((id) => (
            <MessageView key={id} id={id} bots={botMap} multiBot={multiBot} />
          ))}

          {streaming && messageIds.length > 0 ? (
            <div className="ob-transcript-working">
              <WorkingPill size="md" />
            </div>
          ) : null}

          {runError ? (
            <div className="ob-notice ob-notice-error ob-transcript-error" role="alert">
              <IconWarning size={13} />
              <span>{runError}</span>
              <BackendSetupLink text={runError} />
              <button type="button" className="ob-btn ob-btn-sm" onClick={() => store.clearRunError()}>
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {showJump ? (
        <button type="button" className="ob-transcript-jump" onClick={() => toBottom('smooth')} aria-label="Jump to latest message">
          <IconArrowDown size={13} />
          Latest
        </button>
      ) : null}
    </div>
  )
}
