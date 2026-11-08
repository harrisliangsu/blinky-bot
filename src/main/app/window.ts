/** The main window: creation, first paint, and how it loads the renderer. */

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { applyNativeGlass, forgetNativeGlass } from './nativeGlass'
import { getSettings, onSettingsChanged } from '../settings'
import { devServerUrl, preloadScript, rendererHtml } from './bundlePaths'
import { hardenWebContents } from './security'
import { captureScreenshots } from './shots'
import { markSmokeFailed, markSmokeReady } from './smoke'

const WIDTH = 1200
const HEIGHT = 820
const MIN_WIDTH = 720
const MIN_HEIGHT = 520
/** Matches the renderer's dark canvas, so launch never flashes white. */
const BACKGROUND = '#0b0b0c'

/** The legacy under-window transparency is retired. Native glass is confined to navigation. */
export function applyWindowChrome(window: BrowserWindow, _legacyVibrant = false): void {
  if (window.isDestroyed()) return
  if (process.platform === 'darwin') window.setVibrancy(null)
  const status = applyNativeGlass(window, getSettings().nativeGlass !== false)
  window.setBackgroundColor(status.applied ? '#00000000' : BACKGROUND)
  window.webContents.send('openbot:window:chromeChanged', status)
}

export function createWindow(): BrowserWindow {
  const vibrant = false
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: app.getName(),
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
  window.on('closed', () => forgetNativeGlass(window))

  window.once('ready-to-show', () => {
    applyWindowChrome(window)
    markSmokeReady()
    window.show()
    if (process.env.BLINKY_SHOTS === '1') {
      void captureScreenshots(window).catch((err) => {
        console.error('[blinky-shots] failed', err)
      })
    }
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
  const trusted = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && event.senderFrame?.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId ? win : null
  }
  ipcMain.handle('openbot:window:chromeStatus', event => { const win = trusted(event); if (!win) return { supported: false, applied: false, reduced: false }; const status = applyNativeGlass(win, getSettings().nativeGlass !== false); win.setBackgroundColor(status.applied ? '#00000000' : BACKGROUND); return status })
  ipcMain.handle('openbot:window:chromeLayout', (event, width: unknown) => {
    const win = trusted(event); if (!win || typeof width !== 'number' || !Number.isFinite(width)) return
    const status = applyNativeGlass(win, getSettings().nativeGlass !== false, width)
    win.setBackgroundColor(status.applied ? '#00000000' : BACKGROUND)
    win.webContents.send('openbot:window:chromeChanged', status)
  })
  const apply = (): void => {
    for (const window of BrowserWindow.getAllWindows()) applyWindowChrome(window)
  }
  apply()
  onSettingsChanged(() => apply())
  nativeTheme.on('updated', apply)
}

/** The window to act on, creating one if the app has none. */
export function focusOrCreateWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (!existing) return createWindow()
  if (existing.isMinimized()) existing.restore()
  existing.focus()
  return existing
}
