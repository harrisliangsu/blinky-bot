/**
 * Process-wide hardening.
 *
 * The renderer is a local app, not a browser: it may never navigate itself to
 * a remote origin, and anything that wants a new window gets handed to the
 * user's real browser instead. This module is also the single install point
 * the entry calls before anything else runs, so the permission policy and the
 * process-level crash guards are registered from here.
 */

import { dirname, sep } from 'node:path'
import { app, BrowserWindow, shell, type WebContents } from 'electron'
import { getSettings } from '../settings'
import { devServerUrl, rendererHtml } from './bundlePaths'
import { installCrashGuards } from './crashGuards'
import { canonical, isInternalUrl, type RendererLocation } from './internalUrl'
import { hardenSession } from './permissions'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Every webContents already hardened, so listeners are never doubled up. */
const hardened = new WeakSet<WebContents>()

/**
 * Where the renderer legitimately lives. Navigation to `file://` is confined
 * to the built renderer's directory: without that, `location = 'file:///…'`
 * from page content would load an arbitrary local file into a window that
 * still has the preload bridge attached, handing that file the whole
 * `OpenBotApi`.
 */
function rendererLocation(): RendererLocation {
  return {
    devUrl: devServerUrl(),
    rendererRoot: canonical(dirname(rendererHtml())) + sep
  }
}

/**
 * Total by construction: a listener that throws never reaches its own
 * `event.preventDefault()`, so any failure to classify a URL has to read as
 * "not ours" rather than propagate.
 */
function isInternal(url: string): boolean {
  try {
    return isInternalUrl(url, rendererLocation())
  } catch (err) {
    console.error('[openbot/security] could not classify url; treating it as external', err)
    return false
  }
}

/** Open http(s)/mailto in the user's browser; refuse anything else. */
function openExternal(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (!EXTERNAL_PROTOCOLS.has(protocol)) {
    console.warn('[openbot/security] blocked link with unsupported protocol:', protocol)
    return
  }
  if (getSettings().linkOpen === 'window' && (protocol === 'http:' || protocol === 'https:')) {
    const child = new BrowserWindow({
      width: 960,
      height: 720,
      title: 'BlinkyBot',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    void child.loadURL(url).catch((err) => {
      console.error('[openbot/security] could not open the link in a window', err)
    })
    return
  }
  void shell.openExternal(url).catch((err) => {
    console.error('[openbot/security] could not open external url', err)
  })
}

export function hardenWebContents(contents: WebContents): void {
  // `web-contents-created` fires while `new BrowserWindow()` is still running,
  // so the window's own call would otherwise register a second set of
  // listeners — and every external link would open two browser tabs.
  if (hardened.has(contents)) return
  hardened.add(contents)

  // Covers a custom partition too, which `session-created` alone would only
  // reach if it were created after `installSecurity()` ran.
  hardenSession(contents.session)

  contents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return
    event.preventDefault()
    openExternal(url)
  })

  // Subframes get their own event. They have no preload, so they are simply
  // pinned in place rather than handed to the browser.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || isInternal(event.url)) return
    event.preventDefault()
  })

  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  // Nothing in OpenBOT embeds a webview; if one appears, strip its privileges.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/** Apply every guard the process needs, before the app becomes ready. */
export function installSecurity(): void {
  installCrashGuards()

  // The default session does not exist yet at this point, so the policy is
  // attached as sessions appear rather than by touching `defaultSession` here.
  app.on('session-created', (session) => {
    hardenSession(session)
  })

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents)
  })
}
