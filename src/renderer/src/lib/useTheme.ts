import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Explicit light/dark wins. `system` and a missing preference follow the OS. */
export function resolveTheme(theme: Settings['theme'] | undefined, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return systemDark ? 'dark' : 'light'
}

/** The theme actually painted, including while the preference is still `system`. */
export function useResolvedTheme(theme: Settings['theme'] | undefined): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches)

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const onChange = (): void => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return resolveTheme(theme, systemDark)
}

/**
 * Reflects the theme and font-size preferences onto the document root, where
 * tokens.css picks them up. 'system' follows the OS and keeps following it.
 */
export function useTheme(settings: Pick<Settings, 'theme' | 'fontSize' | 'uiScale' | 'accent' | 'vibrant'> | undefined): void {
  const theme = settings?.theme
  const fontSize = settings?.fontSize
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia(DARK_QUERY)

    const apply = (): void => {
      root.setAttribute('data-theme', resolveTheme(theme, media.matches))
    }

    apply()
    if (theme !== undefined && theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    if (fontSize === undefined) return
    const clamped = Math.min(24, Math.max(9, Math.round(fontSize)))
    root.style.setProperty('--ob-font-size-base', `${clamped}px`)
  }, [fontSize])

  useEffect(() => {
    const root = document.documentElement
    const scale = settings?.uiScale ?? 100
    root.style.zoom = `${scale}%`
    if (settings?.accent && settings.accent !== 'theme') root.dataset.accent = settings.accent
    else delete root.dataset.accent
    root.dataset.vibrant = settings?.vibrant ? 'true' : 'false'
  }, [settings?.uiScale, settings?.accent, settings?.vibrant])
}
