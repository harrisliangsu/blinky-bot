import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react'
import type { ScrollGeometry } from './stickyScroll'

const BOTTOM_EPSILON = 2

function geometry(el: HTMLElement): ScrollGeometry {
  return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight }
}

/** Main-chat scroll intent. Layout changes must not be mistaken for user input. */
export function useTranscriptScroll(sessionId: string | undefined, ready: boolean, onChange: (value: ScrollGeometry) => void) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previous = useRef<ScrollGeometry | null>(null)
  const notify = useRef(onChange)
  notify.current = onChange
  const prepend = useRef<{ node: Element; top: number } | null>(null)
  const touchY = useRef<number | null>(null)
  const followFrame = useRef(0)
  const readHistory = useCallback(() => { following.current = false; if (scrollerRef.current) scrollerRef.current.style.overflowAnchor = 'auto' }, [])

  const report = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    previous.current = geometry(el)
    notify.current(previous.current)
  }, [])

  const pin = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    if (following.current) {
      // Native scroll anchoring can undo a pin after image/text reflow.
      el.style.overflowAnchor = 'none'
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
      // Instant positioning avoids a smooth-scroll intermediate event turning
      // follow off, or an old animation fighting a later image/stream resize.
      if (Math.abs(el.scrollTop - bottom) > BOTTOM_EPSILON) el.scrollTop = bottom
    }
    report()
  }, [report])

  const jump = useCallback(() => {
    following.current = true
    pin()
  }, [pin])

  useLayoutEffect(() => {
    following.current = true
    previous.current = null
    prepend.current = null
    if (ready) pin()
  }, [sessionId, ready, pin])

  const contentRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const observer = new ResizeObserver(pin)
    observer.observe(node)
    // Composer/window resizing can change only the viewport, not the content.
    if (node.parentElement) observer.observe(node.parentElement)
    return () => observer.disconnect()
  }, [pin])

  useEffect(() => {
    const sent = (event: Event): void => { if ((event as CustomEvent<string>).detail === sessionId) pin() }
    const viewport = (): void => { requestAnimationFrame(pin) }
    window.addEventListener('openbot:chat-sent', sent)
    window.visualViewport?.addEventListener('resize', viewport)
    return () => { window.removeEventListener('openbot:chat-sent', sent); window.visualViewport?.removeEventListener('resize', viewport) }
  }, [sessionId, pin])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const next = geometry(el)
    const atBottom = next.scrollHeight - next.scrollTop - next.clientHeight <= BOTTOM_EPSILON
    if (atBottom) { following.current = true; el.style.overflowAnchor = 'none' }
    else if (following.current) {
      // Focusing/selecting the composer can move Chromium's scroll chain
      // without changing either box size, so ResizeObserver cannot repair it.
      cancelAnimationFrame(followFrame.current)
      followFrame.current = requestAnimationFrame(pin)
    }
    // Scroll events also follow layout clamping/anchoring. Only actual input
    // below opts out of follow; a programmatic adjustment is not reading intent.
    // A size/anchor-generated event leaves intent intact; ResizeObserver pins
    // only when that intent is still to follow.
    previous.current = next
    notify.current(next)
  }, [pin])

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) readHistory()
  }, [readHistory])
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'End') {
      // End expresses the same follow intent as Latest. Native scrolling alone
      // can stop short when a streamed layout changes its destination.
      event.preventDefault()
      jump()
    } else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) readHistory()
  }, [jump, readHistory])
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Native scrollbar dragging targets the scroller itself.
    if (event.pointerType === 'mouse' && event.target === event.currentTarget) readHistory()
  }, [readHistory])
  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => { touchY.current = event.touches.length === 1 ? event.touches[0]!.clientY : null }, [])
  const onTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return
    const y = event.touches[0]!.clientY
    if (touchY.current !== null && y > touchY.current + 2) readHistory()
    touchY.current = y
  }, [readHistory])

  const preservePrepend = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const node = Array.from(el.querySelectorAll('.ob-msg, .ob-task-clarification')).find(item => item.getBoundingClientRect().bottom > top)
    if (node) prepend.current = { node, top: node.getBoundingClientRect().top }
    readHistory()
  }, [readHistory])
  const restorePrepend = useCallback(() => {
    const el = scrollerRef.current, anchor = prepend.current
    prepend.current = null
    if (!el || !anchor?.node.isConnected) return
    el.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    report()
  }, [report])

  useEffect(() => {
    const before = (event: Event): void => { if ((event as CustomEvent<string>).detail === sessionId && !following.current) preservePrepend() }
    const after = (event: Event): void => { if ((event as CustomEvent<string>).detail === sessionId) requestAnimationFrame(restorePrepend) }
    window.addEventListener('blinky:remote-history-before', before)
    window.addEventListener('blinky:remote-history-after', after)
    return () => { window.removeEventListener('blinky:remote-history-before', before); window.removeEventListener('blinky:remote-history-after', after) }
  }, [sessionId, preservePrepend, restorePrepend])
  useEffect(() => () => cancelAnimationFrame(followFrame.current), [])

  return { scrollerRef, contentRef, onScroll, onWheel, onKeyDown, onPointerDown, onTouchStart, onTouchMove, pin, jump, preservePrepend, restorePrepend }
}
