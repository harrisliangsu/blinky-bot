import { useEffect } from 'react'

/** Follow the usable keyboard viewport without disabling pinch zoom or scrolling the document. */
export function useRemoteViewport(): void {
  useEffect(() => {
    const root = document.documentElement, viewport = window.visualViewport
    let frame = 0
    const apply = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        // Pinch zoom is a user action. Do not resize the layout underneath it.
        if (viewport && Math.abs(viewport.scale - 1) > .05) return
        root.style.setProperty('--remote-height', `${viewport?.height ?? innerHeight}px`)
        root.style.setProperty('--remote-top', `${viewport?.offsetTop ?? 0}px`)
      })
    }
    apply(); viewport?.addEventListener('resize', apply); viewport?.addEventListener('scroll', apply); window.addEventListener('resize', apply)
    return () => { cancelAnimationFrame(frame); viewport?.removeEventListener('resize', apply); viewport?.removeEventListener('scroll', apply); window.removeEventListener('resize', apply) }
  }, [])
}
