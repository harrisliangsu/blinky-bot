/**
 * The provider itself: one bot's Chrome instance behind three capabilities.
 *
 *   1. `ComputerProvider` — the bot sees and drives the page.
 *   2. Screencast        — a live frame stream for the UI.
 *   3. Input forwarding  — the *user* drives the page, to sign in.
 *
 * The `ComputerProvider` surface is exactly the shared contract, so the tool
 * handlers cannot tell a browser target from the local Mac or a VM. Everything
 * past that (start/stop/status, the dock, the live view) is extra surface for
 * the UI. Real work lives in the sibling modules — this composes them and owns
 * the per-instance state (the session, the dock, the last screenshot scale).
 */

import type { ComputerProvider, MouseButton, ScreenFrame } from '../../../../shared/types'
import { AppDock, type AppInstallInput, type InstalledApp } from './apps'
import { captureViewport, startScreencast, type ScreencastFrame } from './capture'
import { CHROME_MISSING_MESSAGE, findChrome, type BrowserSpec } from './chrome'
import { ChromeSession, type SessionState } from './chromeSession'
import * as input from './input'
import { currentUrl, navigate, openApp } from './navigation'
import { inspectProfileLock, profileLayout } from './profile'


export interface BrowserStatus {
  botId: string
  state: SessionState
  /** Chrome's DevTools endpoint — a real loopback control surface. */
  endpoint?: string
  width: number
  height: number
  startedAt?: number
  lastError?: string
  apps: InstalledApp[]
}

export class BrowserComputerProvider implements ComputerProvider {
  readonly kind = 'browser' as const

  private readonly session: ChromeSession
  private readonly dock: AppDock
  private readonly layout: ReturnType<typeof profileLayout>
  /** Scale of the last screenshot; incoming coordinates are in that space. */
  private lastScale = 1
  private stopCast: (() => Promise<void>) | undefined

  constructor(
    readonly spec: BrowserSpec,
    userDataDir?: string
  ) {
    this.layout = profileLayout(spec.botId, userDataDir)
    this.session = new ChromeSession(spec, this.layout)
    this.dock = new AppDock(this.layout.appsFile)
  }

  get botId(): string {
    return this.spec.botId
  }

  /* ── ComputerProvider ──────────────────────────────────────── */

  async probe(): Promise<{ ok: boolean; detail?: string }> {
    const chrome = await findChrome()
    if (!chrome) return { ok: false, detail: CHROME_MISSING_MESSAGE }

    const lock = await inspectProfileLock(this.layout.profileDir)
    if (lock.locked && !lock.stale && !this.session.isRunning) {
      return {
        ok: false,
        detail:
          `This bot's browser profile is locked by another process (pid ${lock.pid}). ` +
          'Close the other BlinkyBot window driving this bot, then try again.'
      }
    }

    if (!this.session.isRunning) {
      return {
        ok: true,
        detail: `Ready to start: ${chrome} with a free profile. The browser starts on first use.`
      }
    }

    try {
      const cdp = await this.session.client()
      await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 5000 })
      const url = await currentUrl(cdp)
      return {
        ok: true,
        detail: `Running at ${this.spec.width}×${this.spec.height}${url ? ` on ${url}` : ''}.`
      }
    } catch (err) {
      return {
        ok: false,
        detail: `This bot's browser is not responding: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  async screenshot(): Promise<ScreenFrame> {
    const frame = await captureViewport(await this.session.client(), this.spec)
    // Remember the scale: every coordinate that comes back is expressed in this
    // frame's space and must be divided by it before dispatch.
    this.lastScale = frame.scale
    return frame
  }

  async click(x: number, y: number, button: MouseButton = 'left', clickCount = 1): Promise<void> {
    await input.click(await this.session.client(), x, y, this.lastScale, button, clickCount)
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await input.moveMouse(await this.session.client(), x, y, this.lastScale)
  }

  async typeText(text: string): Promise<void> {
    await input.typeText(await this.session.client(), text)
  }

  async keyPress(combo: string): Promise<void> {
    await input.keyPress(await this.session.client(), combo)
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await input.scroll(await this.session.client(), x, y, dx, dy, this.lastScale)
  }

  async drag(from: [number, number], to: [number, number]): Promise<void> {
    await input.drag(await this.session.client(), from, to, this.lastScale)
  }

  async openApp(name: string): Promise<void> {
    await openApp(await this.session.client(), this.dock, name)
  }

  async navigate(url: string): Promise<void> {
    await navigate(await this.session.client(), url)
  }

  /**
   * What the computer-use allowlist is checked against: the installed app whose
   * URL the page belongs to, or the hostname. Lets a user grant a bot "Gmail"
   * rather than the whole browser.
   */
  async activeApp(): Promise<string | undefined> {
    if (!this.session.isRunning) return undefined
    const url = await currentUrl(await this.session.client())
    if (!url) return undefined
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return undefined
    }
    const match = this.dock.list().find((app) => hostOf(app.url) === host)
    return match?.name ?? host
  }

  /* ── lifecycle & UI surface ────────────────────────────────── */

  async start(): Promise<void> {
    await this.session.start()
  }

  async stop(): Promise<void> {
    await this.stopCast?.().catch(() => undefined)
    this.stopCast = undefined
    await this.session.stop()
  }

  async status(): Promise<BrowserStatus> {
    await this.dock.ready()
    return {
      botId: this.botId,
      state: this.session.state,
      endpoint: this.session.endpoint,
      width: this.spec.width,
      height: this.spec.height,
      startedAt: this.session.startedAt || undefined,
      lastError: this.session.lastError || undefined,
      apps: this.dock.list()
    }
  }

  /** Live view. Starting a second cast replaces the first. */
  async startScreencast(onFrame: (frame: ScreencastFrame) => void): Promise<void> {
    await this.stopScreencast()
    this.stopCast = await startScreencast(await this.session.client(), this.spec, onFrame)
  }

  async stopScreencast(): Promise<void> {
    const stop = this.stopCast
    this.stopCast = undefined
    await stop?.()
  }

  /** Raw input from the user's live view — never seen by the model. */
  async forwardUserInput(event: input.UserInputEvent): Promise<void> {
    await input.forwardUserInput(await this.session.client(), event)
  }

  listApps(): InstalledApp[] {
    return this.dock.list()
  }

  async installApp(app: AppInstallInput): Promise<InstalledApp> {
    return this.dock.install(app)
  }

  async uninstallApp(id: string): Promise<void> {
    await this.dock.uninstall(id)
  }

  async markSignedIn(id: string, signedIn = true): Promise<void> {
    await this.dock.markSignedIn(id, signedIn)
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
