import { useEffect, useRef, useState, type ReactNode } from 'react'
import { addBotToSession, removeBotFromSession, store, toggleWorkspace, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconChat, IconGrid, IconNote, IconPanel, IconPlus, IconSettings } from './Icons'
import { WorkingPill } from './WorkingPill'
import './AppHeader.css'

/** Window chrome for the conversation: title, participants, panel toggles. */
export function AppHeader(): ReactNode {
  const { session, bots, railOpen, streaming, workspace, activity, tasks } = useAppState()
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }

    /*
     * Escape closed nothing here: focus stays on the trigger, which is a sibling
     * of the menu, so the key went straight to the global handler and stopped
     * the running turn instead of shutting this list. Capture on the document
     * gets there first; stopping propagation is what keeps it from doing both.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.repeat) return
      /*
       * A pending approval outranks this menu.
       *
       * Capture plus `stopPropagation` took EVERY Escape while the picker was
       * open, including the one the user meant for a blocking gate: the first
       * press shut this list, and the command sat waiting behind a scrim that
       * had just eaten the key for rejecting it. Standing down here lets the
       * global handler answer the gate; the picker closes on the next press,
       * or on the click that answers the dialog.
       */
      if (store.getState().approvals.length > 0) return
      e.preventDefault()
      e.stopPropagation()
      setPickerOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [pickerOpen])

  const participants = session ? session.botIds.map((id) => bots.find((b) => b.id === id)).filter((b) => b !== undefined) : []
  const available = bots.filter((b) => !b.archived && !session?.botIds.includes(b.id))
  const unread = activity.filter((item) => !item.read).length
  const runningTasks = tasks.filter((task) => task.status === 'queued' || task.status === 'running').length

  return (
    <header className="ob-header">
      <div className="ob-header-title">
        <h1>{session?.title || 'BlinkyBot'}</h1>
        {streaming ? <WorkingPill /> : null}
      </div>

      <div className="ob-header-right ob-no-drag">
        {session ? (
          <div className="ob-header-bots" ref={pickerRef}>
            {participants.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className="ob-header-bot"
                aria-label={
                  session.botIds.length > 1 ? `Remove ${bot.name} from this exchange` : `${bot.name} — the only bot in this conversation`
                }
                title={bot.name}
                disabled={session.botIds.length <= 1}
                onClick={() => void removeBotFromSession(bot.id)}
              >
                <BotAvatar bot={bot} size="sm" active={bot.id === session.activeBotId} />
              </button>
            ))}

            <button
              type="button"
              className="ob-icon-btn"
              aria-label="Add a bot to this exchange"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              <IconPlus size={12} />
            </button>

            {pickerOpen ? (
              <div className="ob-header-picker" role="menu">
                {available.length === 0 ? (
                  <p className="ob-hint ob-header-picker-empty">Every bot is already here.</p>
                ) : (
                  available.map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      role="menuitem"
                      className="ob-header-picker-item"
                      onClick={() => {
                        void addBotToSession(bot.id)
                        setPickerOpen(false)
                      }}
                    >
                      <BotAvatar bot={bot} size="sm" />
                      {bot.name}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Several chats side by side. Hotkey alone was undiscoverable. */}
        <button
          type="button"
          className="ob-icon-btn"
          aria-pressed={workspace.open}
          title={workspace.open ? 'Back to one chat (Alt+G)' : 'Show several chats at once (Alt+G)'}
          aria-label={workspace.open ? 'Back to a single chat' : 'Show several chats at once'}
          onClick={() => toggleWorkspace()}
        >
          <IconGrid size={13} />
        </button>

        <button
          type="button"
          className="ob-icon-btn"
          aria-pressed={railOpen}
          aria-label={railOpen ? 'Hide the side panel' : 'Show the side panel'}
          onClick={() => store.toggleRail()}
        >
          <IconPanel size={13} />
        </button>

        <button type="button" className="ob-icon-btn ob-header-inbox" aria-label={`Inbox${unread ? `, ${unread} unread` : ''}`} onClick={() => store.setModal('activity')}>
          <IconNote size={13} />
          {unread || runningTasks ? <span className="ob-header-badge">{unread + runningTasks}</span> : null}
        </button>

        <button type="button" className="ob-icon-btn" aria-label="Shared rooms" onClick={() => store.setModal('rooms')}>
          <IconChat size={13} />
        </button>

        <button type="button" className="ob-icon-btn" aria-label="Settings (Command comma)" onClick={() => store.setModal('settings')}>
          <IconSettings size={13} />
        </button>
      </div>
    </header>
  )
}
