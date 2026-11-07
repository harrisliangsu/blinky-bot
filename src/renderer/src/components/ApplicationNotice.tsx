import type { ReactNode } from 'react'
import type { Message } from '../../../shared/types'
import './ApplicationNotice.css'

/** Application receipts stay visible without becoming model-authored answers. */
export function ApplicationNotice({ message, zh = true }: { message: Message; zh?: boolean }): ReactNode {
  if (!message.uiOnly || message.internal || message.role !== 'assistant') return null
  const text = message.displayContent ?? message.content
  if (!text && !message.error) return null
  return <aside className={`ob-application-notice${message.error ? ' has-error' : ''}`} role="note" aria-label={zh ? '工作状态' : 'Work status'}>
    {text ? <p>{text}</p> : null}
    {message.error && message.error !== text ? <p>{message.error}</p> : null}
  </aside>
}
