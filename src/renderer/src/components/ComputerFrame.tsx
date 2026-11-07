import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { captureBotScreen, controlBotScreen, restartBotComputer, returnControl, stopTurn, store, useAppState } from '../state'
import { ComputerFrameControls } from './ComputerFrameControls'
import { ComputerFrameExpanded } from './ComputerFrameExpanded'
import { ComputerFrameEmpty, ComputerFrameHead } from './ComputerFrameHead'
import { ComputerFrameStage, clickMarker, type Natural } from './ComputerFrameStage'
import { useAdminTerminal } from './ComputerFrameTerminal'
import { useComputerScreenPolling } from './useComputerScreenPolling'
import { useDirectScreenInput } from './useDirectScreenInput'
import { useWindowFullScreen } from './useWindowFullScreen'
import { VaultFillControls } from './VaultFillControls'
import './ComputerFrame.css'

/**
 * Latest computer-use frame, with a marker over the most recent click and a
 * pulsing banner while the bot is driving the screen.
 */
export function ComputerFrame(): ReactNode {
  const { computerFrame, computerActive, lastClick, session, bots, streaming, modal, helpRequests } = useAppState()
  const [natural, setNatural] = useState<Natural | null>(null)
  const [takeover, setTakeover] = useState(false)
  const [panel, setPanel] = useState<'screen' | 'terminal'>('screen')
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [url, setUrl] = useState('')
  const activeBot = bots.find((bot) => bot.id === session?.activeBotId)
  const helpRequest = helpRequests.find((request) => request.sessionId === session?.id && request.botId === activeBot?.id)
  const canTakeover = Boolean(activeBot && activeBot.computerTarget.kind !== 'local')
  const canAdmin = activeBot?.computerTarget.kind === 'vm' && activeBot.computerTarget.managed === 'apple-vm'
  const canOpenDesktopApps = activeBot?.computerTarget.kind === 'vm' && activeBot.computerTarget.capabilities?.includes('desktop-v1') === true
  const liveViewing = canTakeover && streaming
  const expanded = modal === 'computer'
  const setExpanded = (open: boolean): void => store.setModal(open ? 'computer' : null)
  const shouldPoll = liveViewing || (expanded && takeover)
  // A frame is an input surface, not merely decoration. Never let a bot switch
  // leave the previous bot's pixels under controls that now target another box.
  const visibleFrame = computerFrame && computerFrame.botId === activeBot?.id && computerFrame.sessionId === session?.id ? computerFrame : null
  const directInput = useDirectScreenInput(activeBot?.id, session?.id, takeover, natural)
  const { fullscreen, toggleFullscreen } = useWindowFullScreen(expanded)
  const terminal = useAdminTerminal(activeBot?.id, takeover && canAdmin)

  useEffect(() => {
    setTakeover(false)
    if (store.getState().modal === 'computer') store.setModal(null)
    setPanel('screen')
    setNatural(null)
    setInput('')
    setUrl('')
  }, [activeBot?.id, session?.id])

  // Never leave human controls active when a new bot run begins. The live view
  // remains read-only until the explicit stop-and-takeover handoff succeeds.
  useEffect(() => {
    if (streaming) setTakeover(false)
  }, [streaming])

  useComputerScreenPolling(activeBot?.id, session?.id, shouldPoll, takeover)

  const perform = async (work: () => Promise<void>): Promise<void> => {
    if (busy || (streaming && !helpRequest)) return
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    if (!activeBot || busy) return
    setBusy(true)
    try {
      await captureBotScreen(activeBot.id)
    } finally {
      setBusy(false)
    }
  }

  const toggleTakeover = async (): Promise<void> => {
    if (!activeBot || busy) return
    if (takeover) {
      if (helpRequest && !(await returnControl(helpRequest.id))) return
      setTakeover(false)
      setPanel('screen')
      return
    }

    setBusy(true)
    try {
      // request_help leaves the turn running but blocked inside the tool. Do
      // not abort the turn that should resume after the user hands control back.
      if (streaming && !helpRequest && !(await stopTurn())) return
      // Require a fresh frame before enabling input. This proves the VM is
      // reachable and ensures clicks map to the current pixel dimensions.
      if (await captureBotScreen(activeBot.id)) {
        setTakeover(true)
        setExpanded(true)
        setPanel('screen')
      }
    } finally {
      setBusy(false)
    }
  }

  const clickScreen = (event: MouseEvent<HTMLImageElement>): void => {
    if (!takeover || !activeBot || !natural) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * natural.width
    const y = ((event.clientY - rect.top) / rect.height) * natural.height
    void perform(() => controlBotScreen(activeBot.id, { type: 'click', x, y }))
  }

  const sendText = (): void => {
    if (!activeBot || !input) return
    const value = input
    setInput('')
    void perform(() => controlBotScreen(activeBot.id, { type: 'type', text: value }))
  }

  const navigate = (): void => {
    if (!activeBot || !url.trim()) return
    const destination = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
    setUrl(destination)
    void perform(() => controlBotScreen(activeBot.id, { type: 'navigate', url: destination }))
  }

  const restartVm = async (): Promise<void> => {
    if (!activeBot || busy || streaming || takeover) return
    setBusy(true)
    try {
      if (await restartBotComputer(activeBot.id)) await captureBotScreen(activeBot.id)
    } finally {
      setBusy(false)
    }
  }

  const closeExpanded = (): void => {
    setExpanded(false)
  }

  if (!visibleFrame) {
    return (
      <ComputerFrameEmpty
        liveViewing={liveViewing}
        canTakeover={canTakeover}
        busy={busy}
        streaming={streaming}
        waitingForHelp={Boolean(helpRequest)}
        onToggleTakeover={() => void toggleTakeover()}
      />
    )
  }

  const marker = clickMarker(lastClick, activeBot?.id, natural, visibleFrame.at)

  return (
    <>
    <section className="ob-cframe" aria-label="Screen">
      {helpRequest ? (
        <div className="ob-cframe-help" role="alert">
          <strong>{activeBot?.name ?? 'The bot'} needs you</strong>
          <span>{helpRequest.reason}</span>
        </div>
      ) : null}
      <ComputerFrameHead
        liveViewing={liveViewing}
        at={visibleFrame.at}
        canTakeover={canTakeover}
        takeover={takeover}
        busy={busy}
        streaming={streaming}
        waitingForHelp={Boolean(helpRequest)}
        onRefresh={() => void refresh()}
        onEnlarge={() => setExpanded(true)}
        onToggleTakeover={() => void toggleTakeover()}
      />

      {liveViewing ? (
        <p className="ob-cframe-live" role="status">
          <span className="ob-cframe-pulse" aria-hidden="true" />
          {computerActive ? 'Bot is controlling the VM screen' : 'Watching the VM while the bot works'}
        </p>
      ) : takeover ? (
        <p className="ob-cframe-live ob-cframe-yours" role="status">You are in control · {helpRequest ? 'the bot is waiting' : 'the bot is stopped'}</p>
      ) : null}

      <ComputerFrameStage
        screenshot={visibleFrame.screenshot}
        marker={marker}
        takeover={takeover}
        onClick={clickScreen}
        onNatural={setNatural}
      />

      {takeover && activeBot ? (
        <ComputerFrameControls
          url={url}
          onUrl={setUrl}
          onNavigate={navigate}
          text={input}
          onText={setInput}
          onSendText={sendText}
          busy={busy}
          canOpenDesktopApps={canOpenDesktopApps}
          onKey={(combo) => void perform(() => controlBotScreen(activeBot.id, { type: 'key', combo }))}
          onOpenDesktopTerminal={() => void perform(() => controlBotScreen(activeBot.id, { type: 'openApp', name: 'terminal' }))}
          onScrollDown={() => void perform(() => controlBotScreen(activeBot.id, { type: 'scroll', x: natural?.width ? natural.width / 2 : 700, y: natural?.height ? natural.height / 2 : 450, dx: 0, dy: 600 }))}
        />
      ) : null}

      {canTakeover && !takeover ? (
        <p className="ob-hint ob-cframe-hint">The live view is the VM’s Linux desktop. Shell and file activity stay visible in the chat.</p>
      ) : null}

      {marker ? (
        <p className="ob-cframe-coords">
          Click at {Math.round(lastClick!.x)}, {Math.round(lastClick!.y)}
        </p>
      ) : null}
    </section>

    {expanded && activeBot ? (
      <ComputerFrameExpanded
        botName={activeBot.name}
        screenshot={visibleFrame.screenshot}
        marker={marker}
        takeover={takeover}
        waitingForHelp={Boolean(helpRequest)}
        liveViewing={liveViewing}
        streaming={streaming}
        busy={busy}
        canAdmin={canAdmin}
        panel={panel}
        onPanel={setPanel}
        fullscreen={fullscreen}
        onToggleFullscreen={() => void toggleFullscreen()}
        url={url}
        onUrl={setUrl}
        onNavigate={navigate}
        onNatural={setNatural}
        input={directInput}
        terminal={terminal}
        onClose={closeExpanded}
        onRefresh={() => void refresh()}
        onRestartVm={() => void restartVm()}
        onToggleTakeover={() => void toggleTakeover()}
        vaultControls={takeover && !streaming && activeBot.computerTarget.kind === 'browser' && session ? <VaultFillControls botId={activeBot.id} sessionId={session.id} /> : null}
      />
    ) : null}
    </>
  )
}
