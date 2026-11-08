import { app, nativeTheme, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getSettings } from '../settings'
import { updateGlassSurface, type GlassBridge as Bridge, type ChromeStatus } from './glassPolicy'
export type { ChromeStatus } from './glassPolicy'
let bridge: Bridge | null | undefined
const widths = new Map<number, number>()
function native(): Bridge | null {
  if (bridge !== undefined) return bridge
  bridge = null
  if (process.platform === 'darwin') try {
    bridge = createRequire(import.meta.url)(app.isPackaged ? join(process.resourcesPath, 'speech', 'BlinkyGlass.node') : join(app.getAppPath(), 'out/native/BlinkyGlass.node')) as Bridge
  } catch { /* Unsupported builds retain the opaque surface. */ }
  return bridge
}
export function applyNativeGlass(window: BrowserWindow, enabled: boolean, width?: number): ChromeStatus {
  if (width !== undefined) widths.set(window.id, Math.max(0, Math.min(480, Number.isFinite(width) ? width : 0)))
  const module = native()
  const theme = getSettings().theme
  const dark = theme === 'dark' || theme === 'system' && nativeTheme.shouldUseDarkColors
  if (window.isDestroyed()) return { supported: false, applied: false, reduced: false }
  return updateGlassSurface(module, window.getNativeWindowHandle(), widths.get(window.id) ?? 240, enabled, dark, nativeTheme.prefersReducedTransparency || nativeTheme.shouldUseHighContrastColors)
}
export function forgetNativeGlass(window: BrowserWindow): void { widths.delete(window.id) }
