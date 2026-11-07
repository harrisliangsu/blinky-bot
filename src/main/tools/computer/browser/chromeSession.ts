/**
 * The lifecycle of one bot's Chrome: launch, attach, stop.
 *
 * Owns the process and the CDP connection to a single page target, and nothing
 * above that — capture, input and navigation take the connected client from
 * here and speak protocol themselves.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { setTimeout as setNodeTimeout } from 'node:timers'
import { ToolError } from '../../errors'
import { CdpClient } from './cdpClient'
import { chromeLaunchArgs, findChrome, CHROME_MISSING_MESSAGE, type BrowserSpec } from './chrome'
import { clearStaleLock, clearStalePortFile, inspectProfileLock, portFilePath, type ProfileLayout } from './profile'

export type SessionState = 'stopped' | 'starting' | 'running' | 'error'

const PORT_WAIT_MS = 20_000
const PORT_POLL_MS = 100
const ATTACH_TIMEOUT_MS = 5_000
const KILL_GRACE_MS = 3_000

export class ChromeSession {
  private proc: ChildProcess | undefined
  private cdp: CdpClient | undefined
  private startInFlight: Promise<void> | undefined
  private devtoolsPort = 0

  state: SessionState = 'stopped'
  lastError = ''
  startedAt = 0

  constructor(
    private readonly spec: BrowserSpec,
    private readonly layout: ProfileLayout
  ) {}

  get endpoint(): string | undefined {
    return this.devtoolsPort ? `http://127.0.0.1:${this.devtoolsPort}` : undefined
  }

  get isRunning(): boolean {
    return this.state === 'running' && this.cdp?.isOpen === true
  }

  /**
   * The connected client, starting the browser if it is not up yet. Callers in
   * the tool layer never have to sequence a start themselves.
   */
  async client(): Promise<CdpClient> {
    if (!this.isRunning) await this.start()
    if (!this.cdp?.isOpen) {
      throw new ToolError(
        `This bot's browser is not running${this.lastError ? `: ${this.lastError}` : '.'}`,
        'Try again — it will be started automatically — or check the browser target in Settings.'
      )
    }
    return this.cdp
  }

  /**
   * Two callers racing to start one bot's browser would spawn two Chrome
   * processes against the same profile; the second dies on the profile lock and
   * orphans itself. Share the in-flight start instead.
   */
  async start(): Promise<void> {
    if (this.isRunning) return
    if (this.startInFlight) return this.startInFlight
    this.startInFlight = this.launch().finally(() => {
      this.startInFlight = undefined
    })
    return this.startInFlight
  }

  private async launch(): Promise<void> {
    const chrome = await findChrome()
    if (!chrome) {
      this.state = 'error'
      this.lastError = CHROME_MISSING_MESSAGE
      throw new ToolError(CHROME_MISSING_MESSAGE)
    }

    const lock = await inspectProfileLock(this.layout.profileDir)
    if (lock.locked && !lock.stale) {
      this.state = 'error'
      this.lastError = `profile is locked by process ${lock.pid}`
      throw new ToolError(
        `This bot's browser profile is already open in another process (pid ${lock.pid}).`,
        'Each bot has one browser. Close the other BlinkyBot window driving this bot, or wait for it to finish.'
      )
    }

    this.state = 'starting'
    await mkdir(this.layout.profileDir, { recursive: true })
    await clearStaleLock(this.layout.profileDir)
    await clearStalePortFile(this.layout.profileDir)

    try {
      this.proc = spawn(chrome, chromeLaunchArgs(this.spec, this.layout.profileDir), {
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (err) {
      this.state = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      throw new ToolError(`Could not launch ${chrome}: ${this.lastError}`)
    }

    this.proc.on('exit', (code) => {
      this.state = 'stopped'
      if (code !== 0 && code !== null) this.lastError = `browser exited with code ${code}`
      this.cdp?.close()
      this.cdp = undefined
    })

    try {
      this.devtoolsPort = await this.waitForDevToolsPort()
      this.cdp = await CdpClient.connect(await this.attachToPage())
      await this.configurePage(this.cdp)
    } catch (err) {
      this.state = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      await this.stop()
      throw err instanceof ToolError
        ? err
        : new ToolError(
            `This bot's browser did not finish starting: ${this.lastError}`,
            'Check that the browser is installed and not blocked by a security policy, then try again.'
          )
    }

    this.state = 'running'
    this.startedAt = Date.now()
    this.lastError = ''
  }

  /** Fixed viewport, so screenshot coordinates are stable and predictable. */
  private async configurePage(cdp: CdpClient): Promise<void> {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.spec.width,
      height: this.spec.height,
      deviceScaleFactor: 1,
      mobile: false
    })
  }

  private async waitForDevToolsPort(): Promise<number> {
    const file = portFilePath(this.layout.profileDir)
    const deadline = Date.now() + PORT_WAIT_MS
    while (Date.now() < deadline) {
      const first = await readFile(file, 'utf8')
        .then((text) => text.split('\n')[0]?.trim())
        .catch(() => undefined)
      if (first) return Number(first)
      const exitCode = this.proc?.exitCode
      if (exitCode !== null && exitCode !== undefined) {
        throw new ToolError(`The browser exited before it finished starting (code ${exitCode}).`)
      }
      await sleep(PORT_POLL_MS)
    }
    throw new ToolError('The browser did not expose a DevTools port in time.')
  }

  /** Reuse an existing page target, or open one. */
  private async attachToPage(): Promise<string> {
    const base = `http://127.0.0.1:${this.devtoolsPort}`
    const list = (await fetchJson(`${base}/json/list`)) as Array<{
      type?: string
      webSocketDebuggerUrl?: string
    }>
    const page = Array.isArray(list)
      ? list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      : undefined
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl

    const created = (await fetchJson(`${base}/json/new?about:blank`, 'PUT')) as {
      webSocketDebuggerUrl?: string
    }
    if (!created.webSocketDebuggerUrl) {
      throw new ToolError("Could not open a page in this bot's browser.")
    }
    return created.webSocketDebuggerUrl
  }

  async stop(): Promise<void> {
    this.cdp?.close()
    this.cdp = undefined
    const proc = this.proc
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // Callers may remove the isolated profile immediately after stop. Wait
      // for this process to exit so it cannot keep writing into that profile.
      await new Promise<void>((resolve, reject) => {
        let finished = false, hardDeadline: ReturnType<typeof setNodeTimeout> | undefined
        const finish = (): void => { if (finished) return; finished = true; clearTimeout(grace); if (hardDeadline) clearTimeout(hardDeadline); proc.off('exit', finish); resolve() }
        const grace = setNodeTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
          hardDeadline = setNodeTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) { proc.off('exit', finish); finished = true; reject(new Error('Browser exit could not be confirmed.')) } else finish() }, 1000)
        }, KILL_GRACE_MS)
        proc.once('exit', finish)
        proc.kill('SIGTERM')
        if (proc.exitCode !== null || proc.signalCode !== null) finish()
      })
    }
    if (this.proc === proc) this.proc = undefined
    this.state = 'stopped'
  }
}

async function fetchJson(url: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) })
  if (!res.ok) throw new ToolError(`The browser's DevTools endpoint answered ${res.status} for ${method} ${url}.`)
  return (await res.json()) as unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setNodeTimeout(resolve, ms))
}
