import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TRANSCRIPT_WINDOW, tailWindow } from '../lib/messageWindow'
import { showsJump } from '../lib/stickyScroll'
import { useTranscriptScroll } from '../lib/useTranscriptScroll'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { respondToApproval, store, useAppState } from '../state'
import { ApprovalDialog } from './ApprovalDialog'
import { BackendSetupLink } from './BackendSetupLink'
import { EarlierMessages } from './EarlierMessages'
import { IconArrowDown, IconSpinner, IconWarning } from './Icons'
import { MessageView } from './Message'
import { BotAvatar } from './BotAvatar'
import { GitHubDraftCards } from './GitHubDraftCards'
import { GmailDraftCards } from './GmailDraftCards'
import { CalendarDraftCards } from './CalendarDraftCards'
import { XDraftCards } from './XDraftCards'
import { SlackDraftCards } from './SlackDraftCards'
import { TaskClarificationCards } from './TaskClarificationCards'
import { ReplyProgress } from './ReplyProgress'
import type { Bot } from '../../../shared/types'
import { imagePreviewSrc } from './imageAttachments'
import type { MessageQueue, QueuedMessage } from '../../../shared/messageQueue'
import './Transcript.css'
import { RoomDevices } from './RoomDevices'

function EmptyTranscript({ hasSession, bot }: { hasSession: boolean; bot?: Bot }): ReactNode {
  const chat = useSettingsCopy().chat
  return (
    <div className="ob-transcript-empty">
      {bot ? <BotAvatar bot={bot} size="lg" /> : null}
      <h2 className="ob-empty-title">{hasSession ? chat.ready : chat.emptyTitle}</h2>
      <p className="ob-empty-body">{chat.emptyBody}</p>
    </div>
  )
}

/** Messages waiting for the execution backend are still ordinary chat bubbles. */
function PendingMessage({ item, queue, known }: { item: QueuedMessage; queue: MessageQueue; known: boolean }): ReactNode {
  return <article className="ob-msg ob-msg-user" aria-label="You">
    <div className="ob-msg-shell">
      {!known && item.text ? <div className="ob-msg-bubble">{item.text}</div> : null}
      {!known && item.attachments.length ? <div className="ob-msg-pictures">{item.attachments.map((attachment) => {
        const src = imagePreviewSrc(attachment)
        return src ? <img key={attachment.id} className="ob-msg-picture" src={src} alt={attachment.name} /> : <span key={attachment.id}>{attachment.name}</span>
      })}</div> : null}
      {item.status === 'interrupted' ? <p className="ob-msg-error">发送状态未确认，请核对对话后处理。 <button type="button" onClick={() => void navigator.clipboard.writeText(item.text)}>复制</button> <button type="button" onClick={() => void window.openbot.agent.removeQueued(queue.sessionId, item.id)}>移除</button></p> : null}
      {queue.paused && item.status === 'waiting' ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => void window.openbot.agent.pauseQueue(queue.sessionId, false).then((result) => { if (!result) store.toast('请先处理发送状态未确认的消息。', 'error') })}>继续处理</button> : null}
    </div>
  </article>
}

/**
 * The message list. Sticks to the bottom while new content streams in, unless
 * the reader has scrolled up — then it stays put and offers a jump button.
 *
 * Only the newest turns are rendered; see `lib/messageWindow` for why.
 */
export function Transcript(): ReactNode {
  const { messageIds, bots, session, sessionLoading, runError, settings, streaming, approvals } = useAppState()
  const localApprovals = approvals.filter((request) => request.sessionId === session?.id)
  const [showJump, setShowJump] = useState(false)
  const [limit, setLimit] = useState(TRANSCRIPT_WINDOW)
  const [queue, setQueue] = useState<MessageQueue | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [, historyChanged] = useState(0)
  const earlierBusy = useRef(false)
  useEffect(() => window.openbot.history?.subscribe(() => historyChanged(n => n + 1)), [])

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

  const { scrollerRef, contentRef, onScroll, onWheel, onKeyDown, onPointerDown, pin, jump, preservePrepend, restorePrepend } = useTranscriptScroll(session?.id, !sessionLoading, (geometry) =>
    setShowJump(showsJump(geometry))
  )

  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b] as const)), [bots])
  const multiBot = (session?.botIds.length ?? 0) > 1
  const { visible, hidden } = tailWindow(messageIds, limit)

  const toBottom = useCallback(
    () => {
      jump()
      setShowJump(false)
    },
    [jump]
  )

  // `messageIds`, not the windowed slice: a full window keeps the same length
  // when a turn arrives, and the list must still follow it down.
  useLayoutEffect(() => {
    pin()
  }, [pin, messageIds, localApprovals[0]?.id])

  useEffect(() => {
    // A different chat starts at its newest turn, and rewinds the window: the
    // "show earlier" the reader opened belonged to the conversation they left.
    setLimit(TRANSCRIPT_WINDOW)
    toBottom()
  }, [session?.id, toBottom])

  useLayoutEffect(restorePrepend, [limit, messageIds, restorePrepend])
  const more = !!session && window.openbot.history?.hasMore(session.id) === true
  const earlier = async () => {
    if (earlierBusy.current) return
    preservePrepend()
    if (hidden > 0) { setLimit(n => n + TRANSCRIPT_WINDOW); return }
    if (!more || !session) return
    earlierBusy.current = true; setLoadingEarlier(true)
    try { await window.openbot.history!.loadEarlier(session.id, preservePrepend); setLimit(n => n + TRANSCRIPT_WINDOW) }
    catch (error) { store.toast(error instanceof Error ? error.message : 'History could not be loaded.', 'error') }
    finally { earlierBusy.current = false; setLoadingEarlier(false) }
  }

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
      <div className="ob-transcript-scroller" ref={scrollerRef} onScroll={event => { onScroll(); if (event.currentTarget.scrollTop < 80 && (hidden > 0 || more)) void earlier() }} onWheel={onWheel} onKeyDown={onKeyDown} onPointerDown={onPointerDown} tabIndex={0} role="log" aria-live="polite" aria-label="Conversation">
        <div className="ob-transcript-content" ref={contentRef}>
          <RoomDevices pendingOnly />
          {messageIds.length === 0 && !runError && !queue?.items.length ? <EmptyTranscript hasSession={session !== null} bot={session?.botIds[0] ? botMap.get(session.botIds[0]) : undefined} /> : null}

          <EarlierMessages hidden={hidden} more={more} loading={loadingEarlier} onShow={() => void earlier()} />

          {visible.map((id) => (
            <MessageView key={id} id={id} bots={botMap} multiBot={multiBot} expandSteps={settings?.expandSteps === true} />
          ))}

          {queue?.items.filter((item) => !messageIds.includes(item.id) || item.status === 'interrupted').map((item) => <PendingMessage key={item.id} item={item} queue={queue} known={messageIds.includes(item.id)} />)}

          {localApprovals[0] ? <ApprovalDialog key={localApprovals[0].id} request={localApprovals[0]} queued={localApprovals.length - 1} onDecide={(decision) => void respondToApproval(localApprovals[0].id, decision)} /> : null}

          {session ? <TaskClarificationCards key={`clarify-${session.id}`} sessionId={session.id} zh={settings?.language !== 'en'} /> : null}
          {session ? <GitHubDraftCards key={session.id} sessionId={session.id} /> : null}
          {session ? <GmailDraftCards key={`gmail-${session.id}`} sessionId={session.id} /> : null}
          {session ? <CalendarDraftCards key={`calendar-${session.id}`} sessionId={session.id} /> : null}
          {session ? <XDraftCards key={`x-${session.id}`} sessionId={session.id} /> : null}
          {session ? <SlackDraftCards key={`slack-${session.id}`} sessionId={session.id} /> : null}

          {session ? <ReplyProgress key={`reply-${session.id}`} sessionId={session.id} active={streaming && !runError} bot={botMap.get(session.activeBotId ?? session.botIds[0])} waitingForApproval={localApprovals.length > 0} zh={settings?.language !== 'en'} /> : null}

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
        <button type="button" className="ob-transcript-jump" onClick={toBottom} aria-label="Jump to latest message">
          <IconArrowDown size={13} />
          Latest
        </button>
      ) : null}
    </div>
  )
}
