import { useState, type ReactNode } from 'react'
import type { AgentMode, BackendInfo } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBackends, setMode, stopTurn, useAppState } from '../state'
import { ContextMeter } from './ContextMeter'
import { IconMic, IconPaperclip, IconSend, IconStop } from './Icons'
import { ModelPicker } from './ModelPicker'

const MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: 'agent', label: 'Agent', hint: 'Runs tools and edits files' },
  { id: 'ask', label: 'Ask', hint: 'Answers without touching anything' },
  { id: 'plan', label: 'Plan', hint: 'Drafts a plan before acting' }
]

interface BarProps {
  onAttach: () => void
  listening: boolean
  onToggleVoice: () => void
  mode: AgentMode
  hasSession: boolean
  backends: BackendInfo[]
  backendId: string
  modelId: string
  backendsLoading: boolean
  backendsError: string | null
  onChooseModel: (backendId: string, modelId: string) => void
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
  mode,
  hasSession,
  backends,
  backendId,
  modelId,
  backendsLoading,
  backendsError,
  onChooseModel,
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

        <div className="ob-mode" role="group" aria-label="Agent mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`ob-mode-btn${mode === m.id ? ' is-active' : ''}`}
              aria-pressed={mode === m.id}
              title={m.hint}
              disabled={!hasSession}
              onClick={() => void setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <ModelPicker
          backends={backends}
          backendId={backendId}
          modelId={modelId}
          onSelect={onChooseModel}
          onRefresh={() => void loadBackends(true)}
          loading={backendsLoading}
          error={backendsError}
          dropUp
          disabled={blocked}
        />
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
