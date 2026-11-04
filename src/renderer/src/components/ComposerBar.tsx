import { useState, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { stopTurn, useAppState } from '../state'
import { ContextMeter } from './ContextMeter'
import { IconMic, IconPaperclip, IconSend, IconStop } from './Icons'

interface BarProps {
  onAttach: () => void
  listening: boolean
  onToggleVoice: () => void
  streaming: boolean
  /** The app failed to boot — nothing here can usefully be pressed. */
  blocked: boolean
  canSend: boolean
  onSend: () => void
}

/** Everything under the message box: what to send with, how, and to stop. */
export function ComposerBar({
  onAttach,
  listening,
  onToggleVoice,
  streaming,
  blocked,
  canSend,
  onSend
}: BarProps): ReactNode {
  const sendHint = useSettingsCopy().general
  const shortcut = useAppState().settings?.sendShortcut ?? 'enter'
  // Stop is one request per run: a second click while the first is in flight
  // issued a second `agent.stop` for a session that is already being torn down.
  const [stopping, setStopping] = useState(false)

  return (
    <div className="ob-composer-bar">
      <div className="ob-composer-left">
        <button type="button" className="ob-icon-btn" onClick={onAttach} aria-label="Attach files" disabled={blocked}>
          <IconPaperclip size={13} />
        </button>
        <button type="button" className={`ob-icon-btn${listening ? ' is-active' : ''}`} onClick={onToggleVoice} aria-pressed={listening} aria-label={listening ? 'Stop voice input' : 'Start voice input'} disabled={streaming || blocked}>
          <IconMic size={13} />
        </button>
      </div>

      <div className="ob-composer-right">
        <ContextMeter />
        <span className="ob-composer-hint">
          {shortcut === 'mod-enter' ? sendHint.sendMod : sendHint.sendEnter}
        </span>
        {streaming ? (
          <button
            type="button"
            className="ob-btn ob-btn-sm ob-btn-danger"
            /* Released whatever the answer: a stop the main process refused
               leaves the run going, and that button has to be clickable. */
            onClick={() => {
              setStopping(true)
              void stopTurn().finally(() => setStopping(false))
            }}
            disabled={stopping}
            aria-label="Stop the run"
          >
            <IconStop size={11} />
            Stop
          </button>
        ) : (
          <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={onSend} disabled={!canSend} aria-label="Send message">
            <IconSend size={12} />
            Send
          </button>
        )}
      </div>
    </div>
  )
}
