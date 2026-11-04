import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { useResolvedTheme } from '../lib/useTheme'
import { addBotToSession, removeBotFromSession, store, updateSettings, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconMoon, IconPlus, IconSun } from './Icons'
import { WorkingPill } from './WorkingPill'
import './AppHeader.css'

/** Sun while the window is light, moon while it is dark. Click pins the other. */
function ThemeToggle(): ReactNode {
  const theme = useAppState().settings?.theme
  const copy = useSettingsCopy().general
  const resolved = useResolvedTheme(theme)
  const next = resolved === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className="ob-icon-btn"
      aria-label={next === 'light' ? copy.themeUseLight : copy.themeUseDark}
      title={next === 'light' ? copy.light : copy.dark}
      onClick={() => void updateSettings({ theme: next })}
    >
      {resolved === 'dark' ? <IconMoon size={13} /> : <IconSun size={13} />}
    </button>
  )
}

/** Window chrome: the conversation title, the Bots in it, and the theme. */
export function AppHeader(): ReactNode {
  const { session, bots, streaming } = useAppState()
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

  return (
    <header className="ob-header">
      <div className="ob-header-title">
        <h1>{session?.title || 'BlinkyBot'}</h1>
        {streaming ? <WorkingPill /> : null}
        {session ? (
          <div className="ob-header-bots ob-no-drag" ref={pickerRef}>
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
      </div>

      {/* Workspace, the activity panel, inbox, and rooms stay in Settings. */}
      <div className="ob-header-right ob-no-drag">
        <ThemeToggle />
      </div>
    </header>
  )
}
