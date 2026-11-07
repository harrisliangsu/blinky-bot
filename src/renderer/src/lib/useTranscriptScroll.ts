import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
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

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const next = geometry(el), old = previous.current
    const atBottom = next.scrollHeight - next.scrollTop - next.clientHeight <= BOTTOM_EPSILON
    if (atBottom) following.current = true
    else if (old && next.scrollHeight === old.scrollHeight && next.clientHeight === old.clientHeight && next.scrollTop < old.scrollTop) following.current = false
    // A size/anchor-generated event leaves intent intact; ResizeObserver pins
    // only when that intent is still to follow.
    previous.current = next
    notify.current(next)
  }, [])

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) following.current = false
  }, [])
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'End') {
      // End expresses the same follow intent as Latest. Native scrolling alone
      // can stop short when a streamed layout changes its destination.
      event.preventDefault()
      jump()
    } else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) following.current = false
  }, [jump])
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Native scrollbar dragging targets the scroller itself.
    if (event.target === event.currentTarget) following.current = false
  }, [])

  const preservePrepend = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const node = Array.from(el.querySelectorAll('.ob-msg')).find(item => item.getBoundingClientRect().bottom > top)
    if (node) prepend.current = { node, top: node.getBoundingClientRect().top }
    following.current = false
  }, [])
  const restorePrepend = useCallback(() => {
    const el = scrollerRef.current, anchor = prepend.current
    prepend.current = null
    if (!el || !anchor?.node.isConnected) return
    el.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    report()
  }, [report])

  return { scrollerRef, contentRef, onScroll, onWheel, onKeyDown, onPointerDown, pin, jump, preservePrepend, restorePrepend }
}
