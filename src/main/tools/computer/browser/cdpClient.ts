/**
 * Minimal Chrome DevTools Protocol client — the transport for a browser target.
 *
 * Zero dependencies — uses the global `WebSocket` available in Node 22+ and
 * Electron. We connect straight to a *page* target's debugger URL, which
 * avoids session routing entirely: every command applies to that page.
 */

export interface CdpOptions {
  /** Milliseconds before a command is abandoned. */
  timeoutMs?: number
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method?: string
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

export class CdpClient {
  private ws: WebSocket | null = null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private closed = false
  private closeReason = ''

  private constructor(private readonly url: string) {}

  static async connect(url: string, timeoutMs = 15_000): Promise<CdpClient> {
    const client = new CdpClient(url)
    await client.open(timeoutMs)
    return client
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        reject(new CdpError(`timed out connecting to ${this.url}`))
      }, timeoutMs)

      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpError(`failed to connect to ${this.url}`))
      }

      ws.onclose = (event) => {
        this.closed = true
        this.closeReason = event.reason || `code ${event.code}`
        // Fail everything still in flight rather than hanging forever.
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new CdpError(`connection closed: ${this.closeReason}`))
        }
        this.pending.clear()
      }

      ws.onmessage = (event) => this.handleMessage(String(event.data))
    })
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new CdpError(msg.error.message || 'CDP error'))
      else p.resolve(msg.result ?? {})
      return
    }

    if (msg.method) {
      const set = this.listeners.get(msg.method)
      if (set) for (const fn of set) fn(msg.params)
    }
  }

  /** Send a CDP command and await its result. */
  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: CdpOptions = {}
  ): Promise<T> {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      throw new CdpError(
        `not connected${this.closeReason ? ` (${this.closeReason})` : ''}`,
        method
      )
    }
    const id = ++this.nextId
    const timeoutMs = opts.timeoutMs ?? 30_000

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, method))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })

      try {
        this.ws!.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`failed to send ${method}: ${String(err)}`, method))
      }
    })
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, fn: (params: unknown) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(fn)
    return () => set!.delete(fn)
  }

  /** Wait for a single event, with a timeout that resolves rather than throws. */
  waitFor(method: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false)
      const done = (value: boolean): void => {
        clearTimeout(timer)
        off()
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const abort = (): void => done(false)
      const timer = setTimeout(() => {
        done(false)
      }, timeoutMs)
      const off = this.on(method, () => done(true))
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === 1
  }

  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
  }
}
