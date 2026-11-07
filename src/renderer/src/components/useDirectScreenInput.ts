import {
  useEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent
} from 'react'
import type { HumanComputerAction } from '../../../shared/types'
import { controlBotScreen, store } from '../state'
import type { Natural } from './ComputerFrameStage'

/** Everything the expanded stage binds so a human can drive the VM directly. */
export interface DirectScreenInput {
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
  onWheel: (event: WheelEvent<HTMLDivElement>) => void
}

/**
 * Mouse, keyboard, scroll and paste, forwarded straight to the private screen —
 * in order, coalesced, and only while the human holds control.
 */
export function useDirectScreenInput(
  botId: string | undefined,
  sessionId: string | undefined,
  takeover: boolean,
  natural: Natural | null
): DirectScreenInput {
  const directQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingText = useRef('')
  const textTimer = useRef<number | undefined>(undefined)
  const wheelTimer = useRef<number | undefined>(undefined)
  const pendingWheel = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null)
  const dragStart = useRef<[number, number] | null>(null)

  useEffect(() => {
    pendingText.current = ''
    if (textTimer.current !== undefined) window.clearTimeout(textTimer.current)
    pendingWheel.current = null
    if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current)
  }, [botId, sessionId])

  useEffect(() => () => {
    if (textTimer.current !== undefined) window.clearTimeout(textTimer.current)
    if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current)
  }, [])

  const pointOn = (element: HTMLElement, clientX: number, clientY: number): [number, number] => {
    const rect = element.getBoundingClientRect()
    const width = natural?.width ?? 1440
    const height = natural?.height ?? 900
    return [
      ((clientX - rect.left) / rect.width) * (width || 1440),
      ((clientY - rect.top) / rect.height) * (height || 900)
    ]
  }

  const enqueueDirect = (action: HumanComputerAction): void => {
    if (!botId) return
    directQueue.current = directQueue.current.then(() => {
      if (store.getState().currentSessionId !== sessionId) return
      return controlBotScreen(botId, action, sessionId)
    })
  }

  const flushDirectText = (): void => {
    if (textTimer.current !== undefined) window.clearTimeout(textTimer.current)
    textTimer.current = undefined
    const text = pendingText.current
    pendingText.current = ''
    if (text) enqueueDirect({ type: 'type', text })
  }

  const typeDirectly = (text: string): void => {
    pendingText.current += text
    if (textTimer.current !== undefined) window.clearTimeout(textTimer.current)
    textTimer.current = window.setTimeout(flushDirectText, 45)
  }

  const keyScreen = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!takeover || event.nativeEvent.isComposing) return
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      typeDirectly(event.key)
      return
    }
    const names: Record<string, string> = {
      Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete',
      ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ' ': 'space'
    }
    const key = names[event.key] ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : event.key.length === 1 ? event.key.toLowerCase() : '')
    if (!key || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    flushDirectText()
    const modifiers = [
      event.metaKey ? 'cmd' : '',
      event.ctrlKey ? 'ctrl' : '',
      event.altKey ? 'alt' : '',
      event.shiftKey ? 'shift' : ''
    ].filter(Boolean)
    enqueueDirect({ type: 'key', combo: [...modifiers, key].join('+') })
  }

  const pointerDownScreen = (event: PointerEvent<HTMLDivElement>): void => {
    if (!takeover || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = pointOn(event.currentTarget, event.clientX, event.clientY)
  }

  const pointerUpScreen = (event: PointerEvent<HTMLDivElement>): void => {
    if (!takeover || event.button !== 0 || !dragStart.current) return
    event.preventDefault()
    const from = dragStart.current
    const to = pointOn(event.currentTarget, event.clientX, event.clientY)
    dragStart.current = null
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1])
    enqueueDirect(distance > 6
      ? { type: 'drag', from, to }
      : { type: 'click', x: to[0], y: to[1], clickCount: Math.min(2, Math.max(1, event.detail || 1)) })
  }

  const rightClickScreen = (event: MouseEvent<HTMLDivElement>): void => {
    if (!takeover) return
    event.preventDefault()
    const [x, y] = pointOn(event.currentTarget, event.clientX, event.clientY)
    enqueueDirect({ type: 'click', x, y, button: 'right' })
  }

  const wheelScreen = (event: WheelEvent<HTMLDivElement>): void => {
    if (!takeover) return
    event.preventDefault()
    const [x, y] = pointOn(event.currentTarget, event.clientX, event.clientY)
    const pending = pendingWheel.current
    pendingWheel.current = {
      x,
      y,
      dx: Math.max(-4000, Math.min(4000, (pending?.dx ?? 0) + event.deltaX)),
      dy: Math.max(-4000, Math.min(4000, (pending?.dy ?? 0) + event.deltaY))
    }
    if (wheelTimer.current !== undefined) window.clearTimeout(wheelTimer.current)
    wheelTimer.current = window.setTimeout(() => {
      const scroll = pendingWheel.current
      pendingWheel.current = null
      wheelTimer.current = undefined
      if (scroll) enqueueDirect({ type: 'scroll', ...scroll })
    }, 40)
  }

  const pasteScreen = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (!takeover) return
    const text = event.clipboardData.getData('text')
    if (!text) return
    event.preventDefault()
    typeDirectly(text)
    flushDirectText()
  }

  return {
    onKeyDown: keyScreen,
    onPaste: pasteScreen,
    onPointerDown: pointerDownScreen,
    onPointerUp: pointerUpScreen,
    onContextMenu: rightClickScreen,
    onWheel: wheelScreen
  }
}
