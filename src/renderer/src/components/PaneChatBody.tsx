import { type ReactNode } from 'react'
import type { Bot, Session } from '../../../shared/types'
import { SNAPSHOT_WINDOW, tailWindow } from '../lib/messageWindow'
import { clearPane } from '../state'
import { IconSpinner, IconWarning } from './Icons'
import { PaneChatSnapshot } from './PaneChatSnapshot'

/** What an unfocused pane last read from disk; a null session means it is gone. */
export interface PaneSnapshot {
  id: string
  session: Session | null
}

interface PaneChatBodyProps {
  sessionId: string
  index: number
  snapshot: PaneSnapshot | null
  failed: boolean
  /** The pane is focused and its chat is still being loaded. */
  opening: boolean
  bots: Map<string, Bot>
  multiBot: boolean
}

/** Everything an unfocused pane can be: loading, gone, unreadable, or a copy. */
export function PaneChatBody({ sessionId, index, snapshot, failed, opening, bots, multiBot }: PaneChatBodyProps): ReactNode {
  if (failed) {
    return (
      <p className="ob-pane-status ob-pane-status-warn" role="alert">
        <IconWarning size={13} />
        This conversation could not be read.
      </p>
    )
  }

  if (opening || snapshot?.id !== sessionId) {
    return (
      <p className="ob-pane-status">
        <IconSpinner size={13} />
        {opening ? 'Opening conversation…' : 'Loading snapshot…'}
      </p>
    )
  }

  // Deleted from under the pane — offer the slot back rather than a dead view.
  if (snapshot.session === null) {
    return (
      <div className="ob-pane-status ob-pane-status-warn" role="status">
        <IconWarning size={13} />
        <span>This conversation no longer exists.</span>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          onClick={() => clearPane(index)}
          aria-label={`Empty pane ${index + 1} and choose another conversation`}
        >
          Choose another
        </button>
      </div>
    )
  }

  const messages = snapshot.session.messages.filter(m=>!m.internal)
  if (messages.length === 0) return <p className="ob-pane-empty">No messages yet.</p>

  /*
   * Only the tail. A snapshot pane rendered its chat in full, and every
   * assistant turn parses and sanitizes its own markdown on mount — with six
   * panes open that was six whole histories parsed in one commit. The pane says
   * plainly how much it is not showing; focusing it opens the real thing.
   */
  const { visible, hidden } = tailWindow(messages, SNAPSHOT_WINDOW)
  return (
    <>
      {hidden > 0 ? (
        <p className="ob-pane-earlier">
          {hidden} earlier message{hidden === 1 ? '' : 's'} — focus this pane to read them
        </p>
      ) : null}
      <PaneChatSnapshot messages={visible} bots={bots} multiBot={multiBot} />
    </>
  )
}
