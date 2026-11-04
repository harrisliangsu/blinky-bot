/** The main window: creation, first paint, and how it loads the renderer. */

import { BrowserWindow } from 'electron'
import { getSettings, onSettingsChanged } from '../settings'
import { devServerUrl, preloadScript, rendererHtml } from './bundlePaths'
import { hardenWebContents } from './security'
import { markSmokeFailed, markSmokeReady } from './smoke'

const WIDTH = 1200
const HEIGHT = 820
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
/** Matches the renderer's dark canvas, so launch never flashes white. */
const BACKGROUND = '#0b0b0c'

/** Translucency is chosen in Settings. macOS also gets native vibrancy. */
export function applyWindowChrome(window: BrowserWindow, vibrant: boolean): void {
  if (window.isDestroyed()) return
  if (process.platform === 'darwin') {
    window.setVibrancy(vibrant ? 'under-window' : null)
  }
  window.setBackgroundColor(vibrant ? '#00000000' : BACKGROUND)
}

export function createWindow(): BrowserWindow {
  const vibrant = getSettings().vibrant === true
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'BlinkyBot',
    transparent: true,
    backgroundColor: vibrant ? '#00000000' : BACKGROUND,
    vibrancy: vibrant && process.platform === 'darwin' ? 'under-window' : undefined,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: preloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer parses attacker-influenced content — model replies, tool
      // output, fetched pages — so a Blink bug must not land with the full
      // privileges of the user's account. The preload is emitted as CommonJS
      // specifically so this can stay on: Electron refuses an ESM preload in a
      // sandboxed renderer, and the preload needs nothing but `electron`.
      sandbox: true,
      webviewTag: false,
      spellcheck: true
    }
  })

  hardenWebContents(window.webContents)

  window.once('ready-to-show', () => {
    markSmokeReady()
    window.show()
  })

  const dev = devServerUrl()
  const load = dev ? window.loadURL(dev) : window.loadFile(rendererHtml())
  void load.catch((err) => {
    console.error('[openbot] failed to load renderer', err)
    markSmokeFailed(err)
  })

  return window
}

/** Keep every open window in step with the translucent-window preference. */
export function installWindowChrome(): void {
  const apply = (): void => {
    const vibrant = getSettings().vibrant === true
    for (const window of BrowserWindow.getAllWindows()) applyWindowChrome(window, vibrant)
  }
  apply()
  onSettingsChanged(() => apply())
}

/** The window to act on, creating one if the app has none. */
export function focusOrCreateWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (!existing) return createWindow()
  if (existing.isMinimized()) existing.restore()
  existing.focus()
  return existing
}
