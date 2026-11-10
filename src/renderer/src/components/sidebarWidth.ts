/** Sidebar dimensions in CSS pixels. Keep space for the conversation. */
export const SIDEBAR_DEFAULT_WIDTH = 272
// The traffic lights start at x=16. Leave breathing room after the green
// button even when the navigation is collapsed to an avatar rail.
export const SIDEBAR_MIN_WIDTH = 100
export const SIDEBAR_COMPACT_WIDTH = 132
export const SIDEBAR_MAX_WIDTH = 480
export const SIDEBAR_MAIN_MIN_WIDTH = 460
export const SIDEBAR_WIDTH_STORAGE_KEY = 'blinky.sidebar.width'

export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_MAIN_MIN_WIDTH))
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth(viewportWidth), width)))
}

export function readSidebarWidth(): number {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (saved === null || saved.trim() === '') return SIDEBAR_DEFAULT_WIDTH
    const width = Number(saved)
    if (!Number.isFinite(width) || width <= 0) return SIDEBAR_DEFAULT_WIDTH
    // Keep the preference independent of the current window size so it can be
    // restored when the window is enlarged again.
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // The current window remains usable when storage is unavailable.
  }
}
