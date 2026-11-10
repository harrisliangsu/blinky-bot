import { useEffect, useState, type ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import { newReplyProgress, reduceReplyProgress, replyProgressLabel } from '../lib/replyProgress'
import { BotAvatar } from './BotAvatar'
import './ReplyProgress.css'

interface ReplyProgressProps {
  sessionId: string
  active: boolean
  bot?: Bot
  waitingForApproval: boolean
  zh: boolean
}

/** One transient indicator for the foreground reply, independent of tasks. */
export function ReplyProgress({ sessionId, active, bot, waitingForApproval, zh }: ReplyProgressProps): ReactNode {
  const [progress, setProgress] = useState(newReplyProgress)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => window.openbot.on((event) => {
    setProgress((current) => reduceReplyProgress(current, event, sessionId))
  }), [sessionId])

  useEffect(() => {
    if (!active) { setRevealed(false); setProgress(newReplyProgress()); return }
    // Very short replies should not flash an avatar. Termination is never
    // delayed; streaming prose and the composer remain available throughout.
    const timer = window.setTimeout(() => setRevealed(true), 180)
    return () => window.clearTimeout(timer)
  }, [active])

  if (!active || !revealed || progress.ended) return null
  return <div className="ob-model-progress ob-reply-progress" role="status" aria-live="polite" aria-atomic="true" aria-label={zh ? '回复进度' : 'Reply progress'}>
    <span className="ob-reply-progress-avatar" aria-hidden="true"><BotAvatar bot={bot} size="sm" active /></span>
    <span className="ob-model-progress-text">{replyProgressLabel(progress, waitingForApproval, zh)}</span>
    <span className="ob-reply-progress-pulse" aria-hidden="true">…</span>
  </div>
}
