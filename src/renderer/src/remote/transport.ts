import type { AgentEvent, Message, OpenBotApi, Session } from '../../../shared/types'
import type { RemotePage, RemoteRpcReply, RemoteUpdateReply } from '../../../shared/remoteProtocol'
import { createOpenBotApi, type ApiTransport } from '../../../shared/apiClient'
import { DeviceIdentity, RemoteHttpError, nonce, type RemoteGrant } from './identity'
import { store, loadActivity, loadBots, loadGroups, loadProjects, loadRoutines, loadSessions, loadSettings, loadSkills, loadBackends } from '../state'

interface PageCache { session: Session; page: RemotePage }
export class BrowserTransport implements ApiTransport {
  readonly api: OpenBotApi
  private readonly id = nonce().slice(0, 32)
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()
  private readonly pages = new Map<string, PageCache>()
  private readonly historyListeners = new Set<() => void>()
  private readonly pendingReceipts = new Map<string, ReturnType<DeviceIdentity['messageReceipt']>>()
  private readonly runStates = new Map<string, boolean>()
  private readonly earlier = new Map<string, Promise<void>>()
  private stopped = false
  private polling = false
  private revision = 0
  private pollController: AbortController | null = null
  private metadataRefresh = Promise.resolve()
  private readonly kick = (): void => { this.pollController?.abort(); if (!this.stopped) void this.poll() }
  constructor(private readonly identity: DeviceIdentity, private access: RemoteGrant, private readonly network: (connected: boolean) => void, private readonly lost: (state: string) => void) {
    this.api = createOpenBotApi(this, { kind: 'browser', scope: access.scope, permission: access.permission, initialSessionId: access.sessionId, capabilities: ['workspace', 'public-chat', 'history', 'ordinary-questions', 'browser-files'] })
    this.api.history = {
      hasMore: id => this.pages.get(id)?.page.hasMore === true,
      loadEarlier: (id, beforeApply) => this.loadEarlier(id, beforeApply),
      subscribe: listener => { this.historyListeners.add(listener); return () => this.historyListeners.delete(listener) }
    }
    window.addEventListener('online', this.kick)
    document.addEventListener('visibilitychange', this.kick)
  }
  subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
    let listeners = this.listeners.get(channel)
    if (!listeners) { listeners = new Set(); this.listeners.set(channel, listeners) }
    const receive = listener as (value: unknown) => void; listeners.add(receive)
    if (channel === 'openbot:event') void this.poll()
    return () => { listeners?.delete(receive) }
  }
  private emit(event: AgentEvent): void { for (const listener of this.listeners.get('openbot:event') ?? []) listener(event) }
  private historyChanged(): void { for (const listener of this.historyListeners) listener() }
  private merge(cache: PageCache, incoming: Message[], prepend = false, changes?: RemoteRpcReply['changes']): void {
    const all = new Map(cache.session.messages.map(message => [message.id, message])), order = cache.session.messages.map(message => message.id)
    for (const message of incoming) all.set(message.id, message)
    const combined = prepend ? [...incoming.map(message => message.id), ...order] : [...order, ...incoming.map(message => message.id)]
    let ids = [...new Set(combined)]
    if (changes) {
      for (const id of changes.removed) { all.delete(id); ids = ids.filter(value => value !== id) }
      for (const update of changes.upserts) {
        all.set(update.message.id, update.message)
        if (!ids.includes(update.message.id)) ids.push(update.message.id)
        if (update.move) ids = [...ids.filter(id => id !== update.message.id), update.message.id]
      }
    }
    cache.session = { ...cache.session, messages: ids.map(id => all.get(id)!).filter(Boolean) }
  }
  private acceptPage(reply: RemoteRpcReply, prepend = false): Session {
    const session = reply.value as Session, page = reply.page
    if (!page || session.id !== page.sessionId || !Array.isArray(session.messages)) throw new Error('The conversation response was incomplete.')
    let cache = this.pages.get(session.id)
    const stale = cache && page.revision < cache.page.revision
    if (!cache || reply.changes?.reset) cache = { session, page }
    else {
      const known = new Set(cache.session.messages.map(message => message.id))
      this.merge(cache, stale ? session.messages.filter(message => !known.has(message.id)) : session.messages, prepend, stale ? undefined : reply.changes)
      cache.session = { ...session, messages: cache.session.messages }
      cache.page = { ...page, revision: Math.max(page.revision, cache.page.revision), newerCursor: prepend || stale ? cache.page.newerCursor : page.newerCursor, ...(prepend ? {} : { olderCursor: cache.page.olderCursor, hasMore: cache.page.hasMore }) }
    }
    this.pages.set(session.id, cache); this.historyChanged()
    return cache.session
  }
  private async rpc(channel: string, args: unknown[], extra: Record<string, unknown> = {}): Promise<RemoteRpcReply> {
    try {
      const undefinedArgs = args.flatMap((value, index) => value === undefined ? [index] : [])
      const data = await this.identity.signed('/api/rpc', { channel, args, undefinedArgs, clientId: this.id, ...extra }, this.access) as RemoteRpcReply
      this.network(true); return data
    } catch (error) {
      if (error instanceof RemoteHttpError && error.status === 401) void this.refreshAccess()
      throw error
    }
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (this.stopped) throw new Error('This connection is closed.')
    // These act on this browser, never on the host operating system.
    if (channel === 'openbot:window:isFullScreen') return Boolean(document.fullscreenElement) as T
    if (channel === 'openbot:window:setFullScreen') { if (args[0]) await document.documentElement.requestFullscreen(); else if (document.fullscreenElement) await document.exitFullscreen(); return true as T }
    if (channel === 'openbot:notification:status') return { supported: false, state: 'idle', enabled: false, replies: false } as T
    if (channel === 'openbot:voice:status') return { speech: 'unavailable', microphone: 'unknown', onDevice: false, language: typeof args[0] === 'string' ? args[0] : '', failure: 'host-required' } as T
    if (channel === 'openbot:voice:stop') return undefined as T
    if (channel === 'openbot:voice:start') return { ok: false, error: 'host-required' } as T
    if (channel === 'openbot:gmail-drafts:presented') return false as T
    if (channel === 'openbot:app:openRelease') {
      const url = new URL(String(args[0])); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('This link cannot be opened in the browser.')
      return Boolean(window.open(url.href, '_blank', 'noopener,noreferrer')) as T
    }
    if (channel === 'openbot:dialog:pickFiles') return await this.pickFiles() as T
    if (channel === 'openbot:dialog:pickDirectory') throw new Error('在 Mac 选择本机目录。 / Choose host directories on the Mac.')
    if (channel.startsWith('openbot:notification:') || channel === 'openbot:backends:login' || channel === 'openbot:rooms:decideDevice' || channel === 'openbot:rooms:devices') throw new Error('此操作须在 Mac 上完成。 / Complete this operation on the Mac.')
    if (channel === 'openbot:bots:create' && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      // Templates and both common editors create a persona, not a new local
      // permission grant. The server independently rejects direct escalation.
      args[0] = { ...args[0], tools: [], computerUse: false }
    }
    let receipt: ReturnType<DeviceIdentity['messageReceipt']> | undefined, optimistic: string[] = []
    const extra: Record<string, unknown> = {}
    if (channel === 'openbot:sessions:get') {
      const cache = this.pages.get(String(args[0])); if (cache) extra.knownVersion = cache.page.revision
    }
    if (channel === 'openbot:agent:send' || channel === 'openbot:agent:enqueue') {
      const key = JSON.stringify([args[0], args[1], args[2]])
      receipt = this.pendingReceipts.get(key) ?? this.identity.messageReceipt(String(args[0]), args.slice(1))
      this.pendingReceipts.set(key, receipt); extra.requestId = receipt.id
      optimistic = [...store.optimistic].filter(id => store.getMessage(id)?.content.trim() === String(args[1]).trim())
      const response = await this.rpc(channel, args, extra)
      receipt.acknowledge(); this.pendingReceipts.delete(key)
      for (const id of optimistic) if (store.optimistic.delete(id)) store.dropMessage(id)
      return response.value as T
    }
    const reply = await this.rpc(channel, args, extra)
    if (channel === 'openbot:sessions:get') { const session = this.acceptPage(reply); this.kick(); return session as T }
    if (channel === 'openbot:sessions:watch') this.kick()
    return reply.value as T
  }
  private loadEarlier(id: string, beforeApply?: () => void): Promise<void> {
    const pending = this.earlier.get(id)
    if (pending) return pending
    const operation = this.fetchEarlier(id, beforeApply).finally(() => this.earlier.delete(id))
    this.earlier.set(id, operation); return operation
  }
  private async fetchEarlier(id: string, beforeApply?: () => void): Promise<void> {
    const cache = this.pages.get(id)
    if (!cache?.page.hasMore || !cache.page.olderCursor) return
    const reply = await this.rpc('openbot:remote:history', [id, cache.page.olderCursor])
    if (this.stopped) return
    beforeApply?.()
    const session = this.acceptPage(reply, true)
    this.emit({ type: 'session-updated', session })
  }
  private async pickFiles(): Promise<string[]> {
    if (this.access.permission !== 'control') throw new Error('This device has view-only access.')
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true
    input.style.display = 'none'; document.body.append(input)
    const files = await new Promise<File[]>(resolve => {
      input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
      input.addEventListener('cancel', () => resolve([]), { once: true })
      input.click()
    }).finally(() => input.remove())
    const paths: string[] = []
    for (const file of files) {
      if (file.size > 6 * 1024 * 1024) throw new Error('Choose files up to 6 MB each.')
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const reply = await this.rpc('openbot:remote:upload', [{ name: file.name, data: btoa(binary) }])
      paths.push(String(reply.value))
    }
    return paths
  }
  private async refreshAccess(): Promise<boolean> {
    if (this.stopped) return false
    try {
      const result = await this.identity.check(true)
      if (this.stopped) return false
      if (result.access) { this.access = result.access; if (this.api.environment) this.api.environment.permission = this.access.permission; return true }
      this.stop(); this.lost(result.state); return false
    } catch {
      // This follows an explicit 401, not ordinary Wi-Fi loss. A host that
      // closed its listener cannot reconfirm the rejected grant: drop access.
      if (!this.stopped) { this.stop(); this.lost('expired') }
      return false
    }
  }
  private async applyUpdates(reply: RemoteUpdateReply): Promise<void> {
    for (const update of reply.sessions) {
      const cache = this.pages.get(update.id)
      if (!cache || update.revision < cache.page.revision) continue
      if (update.reset) {
        const data = await this.rpc('openbot:sessions:get', [update.id])
        if (this.stopped) return
        this.pages.delete(update.id)
        const session = this.acceptPage(data); this.emit({ type: 'session-updated', session }); continue
      }
      this.merge(cache, [], false, { revision: update.revision, reset: false, upserts: update.upserts, removed: update.removed })
      cache.page.revision = update.revision
      for (const id of update.removed) this.emit({ type: 'message-removed', sessionId: update.id, messageId: id })
      for (const item of update.upserts) this.emit({ type: 'message-updated', sessionId: update.id, message: item.message, moveToEnd: item.move })
      this.emit({ type: 'message-queue-updated', queue: update.queue })
      if (store.getState().currentSessionId === update.id) window.dispatchEvent(new CustomEvent('blinky:remote-needs-host', { detail: update.needsMac }))
      if (this.runStates.get(update.id) !== update.running) {
        this.runStates.set(update.id, update.running)
        this.emit(update.running ? { type: 'run-started', sessionId: update.id } : { type: 'done', sessionId: update.id })
      }
    }
    this.revision = reply.revision
    this.metadataRefresh = this.metadataRefresh.then(async () => {
      const groups = new Set(reply.groups), any = reply.reset
      const calls: Promise<unknown>[] = []
      if (any || groups.has('workspace:bots')) calls.push(loadBots())
      if (any || groups.has('workspace:groups')) calls.push(loadGroups())
      if (any || groups.has('workspace:projects')) calls.push(loadProjects())
      if (any || groups.has('workspace:routines') || groups.has('routine-updated')) calls.push(loadRoutines())
      if (any || groups.has('workspace:skills')) calls.push(loadSkills())
      if (any || groups.has('settings-updated')) calls.push(loadSettings())
      if (any || groups.has('backends-updated')) calls.push(loadBackends())
      if (any || groups.has('workspace:sessions') || groups.has('session-updated') || groups.has('done')) calls.push(loadSessions())
      if (any || groups.has('task-updated') || groups.has('task-summary-updated') || groups.has('activity-updated') || groups.has('workspace:tasks')) calls.push(loadActivity())
      if (groups.has('task-clarification-updated')) calls.push(this.api.tasks.clarifications().then(requests => { for (const request of requests) this.emit({ type: 'task-clarification-updated', request }) }))
      await Promise.allSettled(calls)
    }).catch(() => {})
  }
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    let failures = 0
    try {
      while (!this.stopped) {
        this.pollController = new AbortController()
        try {
          const versions = Object.fromEntries([...this.pages].map(([id, cache]) => [id, cache.page.revision]))
          const result = await this.identity.signed('/api/events', { clientId: this.id, since: this.revision, versions }, this.access, { signal: this.pollController.signal, timeout: 28_000 }) as RemoteUpdateReply
          if (this.stopped) break
          failures = 0; this.network(true); await this.applyUpdates(result)
        } catch (error) {
          if (this.stopped) break
          if (this.pollController.signal.aborted) continue
          this.network(false)
          if (error instanceof RemoteHttpError && error.status === 401 && !await this.refreshAccess()) break
          await new Promise(resolve => setTimeout(resolve, Math.min(5000, 300 * 2 ** Math.min(failures++, 4))))
        }
      }
    } finally { this.polling = false; this.pollController = null }
  }
  stop(): void {
    this.stopped = true; this.pollController?.abort(); this.pages.clear(); this.listeners.clear(); this.historyListeners.clear()
    window.removeEventListener('online', this.kick); document.removeEventListener('visibilitychange', this.kick)
  }
}
