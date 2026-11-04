/** The main window: creation, first paint, and how it loads the renderer. */

import { BrowserWindow } from 'electron'
import { devServerUrl, preloadScript, rendererHtml } from './bundlePaths'
import { hardenWebContents } from './security'

const WIDTH = 1200
const HEIGHT = 820
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
/** Matches the renderer's dark canvas, so launch never flashes white. */
const BACKGROUND = '#0b0b0c'

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'BlinkyBot',
    backgroundColor: BACKGROUND,
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
    window.show()
  })

  const dev = devServerUrl()
  const load = dev ? window.loadURL(dev) : window.loadFile(rendererHtml())
  void load.catch((err) => {
    console.error('[openbot] failed to load renderer', err)
  })

  return window
}

/** The window to act on, creating one if the app has none. */
export function focusOrCreateWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (!existing) return createWindow()
  if (existing.isMinimized()) existing.restore()
  existing.focus()
  return existing
}
