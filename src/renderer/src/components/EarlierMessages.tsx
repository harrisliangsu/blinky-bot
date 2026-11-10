import type { ReactNode } from 'react'
import './EarlierMessages.css'

interface EarlierMessagesProps {
  /** How many older turns are not rendered. Nothing shows when this is 0. */
  hidden: number
  onShow: () => void
  more?: boolean
  loading?: boolean
}

/**
 * The way back into a long history.
 *
 * A conversation is windowed to its newest turns because every assistant bubble
 * parses and sanitizes its markdown on mount (see `lib/messageWindow`). Nothing
 * is dropped — this says how much is above, and brings back another page of it.
 */
export function EarlierMessages({ hidden, onShow, more, loading }: EarlierMessagesProps): ReactNode {
  if (hidden <= 0 && !more) return null
  return (
    <button type="button" className="ob-btn ob-btn-sm ob-earlier" onClick={onShow} disabled={loading}>
      {loading ? 'Loading…' : hidden > 0 ? `Show earlier messages (${hidden})` : 'Show earlier messages'}
    </button>
  )
}
