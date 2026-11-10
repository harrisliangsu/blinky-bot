import type { CSSProperties, ReactNode } from 'react'
import { pngSrc } from '../lib/format'
import { ClickMarker, type Natural } from './ComputerFrameStage'
import { NavigateRow } from './ComputerFrameControls'
import { ComputerFrameTerminal, type ComputerFrameTerminalProps } from './ComputerFrameTerminal'
import { IconDisplay, IconExpand, IconTerminal } from './Icons'
import { Modal } from './Modal'
import type { DirectScreenInput } from './useDirectScreenInput'

interface ExpandedProps {
  botName: string
  screenshot: string
  marker: CSSProperties | null
  takeover: boolean
  waitingForHelp: boolean
  liveViewing: boolean
  streaming: boolean
  busy: boolean
  canAdmin: boolean
  panel: 'screen' | 'terminal'
  onPanel: (panel: 'screen' | 'terminal') => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  url: string
  onUrl: (url: string) => void
  onNavigate: () => void
  onNatural: (natural: Natural) => void
  /** Raw mouse and keyboard, bound to the stage while the human is in control. */
  input: DirectScreenInput
  terminal: ComputerFrameTerminalProps
  onClose: () => void
  onRefresh: () => void
  onRestartVm: () => void
  onToggleTakeover: () => void
  vaultControls?: ReactNode
}

/**
 * The private computer at working size: a screen you can actually drive, plus
 * the administrator terminal behind its own tab.
 */
export function ComputerFrameExpanded({
  botName,
  screenshot,
  marker,
  takeover,
  waitingForHelp,
  liveViewing,
  streaming,
  busy,
  canAdmin,
  panel,
  onPanel,
  fullscreen,
  onToggleFullscreen,
  url,
  onUrl,
  onNavigate,
  onNatural,
  input,
  terminal,
  onClose,
  onRefresh,
  onRestartVm,
  onToggleTakeover,
  vaultControls
}: ExpandedProps): ReactNode {
  return (
    <Modal
      title={`${botName} · private computer`}
      subtitle={takeover ? (waitingForHelp ? 'Complete the requested step, then hand back to resume.' : 'You are in control. The bot is stopped.') : 'Read-only view of the bot’s current desktop.'}
      size="xl"
      onClose={onClose}
      actions={(
        <span className="ob-cframe-modal-actions">
          <span className="ob-cframe-tabs" role="tablist" aria-label="Private computer view">
            <button
              type="button"
              className={`ob-btn ob-btn-sm${panel === 'screen' ? ' ob-btn-primary' : ''}`}
              role="tab"
              aria-selected={panel === 'screen'}
              onClick={() => onPanel('screen')}
            >
              <IconDisplay size={12} /> Screen
            </button>
            {canAdmin && takeover ? (
              <button
                type="button"
                className={`ob-btn ob-btn-sm${panel === 'terminal' ? ' ob-btn-primary' : ''}`}
                role="tab"
                aria-selected={panel === 'terminal'}
                onClick={() => onPanel('terminal')}
              >
                <IconTerminal size={12} /> Terminal
              </button>
            ) : null}
          </span>
          <button type="button" className="ob-btn ob-btn-sm" onClick={onToggleFullscreen}>
            <IconExpand size={12} /> {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        </span>
      )}
    >
      <div className={`ob-cframe-expanded${fullscreen ? ' is-fullscreen' : ''}`}>
        {panel === 'terminal' && canAdmin && takeover ? (
          <ComputerFrameTerminal {...terminal} />
        ) : (
          <>
            <div className="ob-cframe-expanded-toolbar">
              <span className={takeover ? 'ob-cframe-control-state is-yours' : 'ob-cframe-control-state'}>
                {takeover ? 'Human control' : liveViewing ? 'Bot working · read only' : 'Read only'}
              </span>
              <span className="ob-cframe-actions">
                <button type="button" className="ob-btn ob-btn-sm" onClick={onRefresh} disabled={busy}>Refresh</button>
                {canAdmin ? <button type="button" className="ob-btn ob-btn-sm" onClick={onRestartVm} disabled={busy || streaming || takeover}>Restart VM</button> : null}
                <button
                  type="button"
                  className={`ob-btn ob-btn-sm${takeover ? ' ob-btn-primary' : ''}`}
                  onClick={onToggleTakeover}
                  disabled={busy}
                >
                  {busy ? 'Opening…' : takeover ? (waitingForHelp ? 'Hand back & resume' : 'Release control') : waitingForHelp ? 'Take over' : streaming ? 'Stop bot & take over' : 'Take over'}
                </button>
              </span>
            </div>
            <div
              className="ob-cframe-stage ob-cframe-stage-expanded"
              role="application"
              aria-label="Interactive VM screen. Click to focus, then type normally."
              tabIndex={takeover ? 0 : -1}
              {...input}
            >
              <img
                className="ob-cframe-img ob-cframe-img-expanded"
                src={pngSrc(screenshot)}
                alt="Large live capture of the private computer"
                data-takeover={takeover || undefined}
                draggable={false}
                onLoad={(event) => onNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              />
              <ClickMarker marker={marker} />
            </div>
            {takeover ? (
              <div className="ob-cframe-controls ob-cframe-controls-expanded">
                <NavigateRow url={url} onUrl={onUrl} onNavigate={onNavigate} busy={busy} />
                {vaultControls}
                <p className="ob-hint ob-cframe-direct-hint">Click the screen to focus it, then use your mouse, trackpad and keyboard normally. Dragging and right-click are supported.</p>
              </div>
            ) : (
              <p className="ob-hint ob-cframe-expanded-hint">Take over to click, type, browse, or open the VM administrator terminal.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
