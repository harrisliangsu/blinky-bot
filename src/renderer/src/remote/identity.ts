import nacl from 'tweetnacl'
import { connectProof, statusProof, requestProof, type RemoteChallenge, type RemoteDeviceState } from '../../../shared/remoteAuth'

export const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
export function unhex(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('Invalid device key.')
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
}
export const nonce = (): string => hex(nacl.randomBytes(32))
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const hash = (text: string): string => hex(nacl.hash(encode(text)))
export class RemoteHttpError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code }
}
export interface RemoteGrant { grant: string; permission: 'view' | 'control'; scope: 'room' | 'workspace'; sessionId: string; roomId: string; expiresAt: number }
interface SavedDevice { publicKey: string; secretKey: string; name: string }
export class DeviceIdentity {
  readonly publicKey: string
  private readonly secretKey: Uint8Array
  readonly invitation: string
  readonly hostKey: string
  readonly legacy: boolean
  readonly storageKey: string
  get fingerprint(): string { return hex(nacl.hash(unhex(this.publicKey))).slice(0, 64) }
  name: string
  private offset = 0
  private requestId = ''
  constructor() {
    const fragment = location.hash.slice(1), legacyPath = location.pathname.split('/').at(-1) ?? ''
    const [token, host = ''] = (fragment || legacyPath).split('.')
    if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token) || host && !/^[a-f0-9]{64}$/.test(host)) throw new Error('邀请不完整，请从 Mac 重新复制。 / Copy a complete invitation from the Mac.')
    this.invitation = token; this.hostKey = host; this.legacy = !host
    this.storageKey = 'blinky.remote.connection.' + hash(token + '.' + host).slice(0, 32)
    let saved: SavedDevice | undefined
    try { saved = JSON.parse(localStorage.getItem('blinky.remote.device.v1') ?? 'null') ?? undefined } catch { /* a new key needs fresh host consent */ }
    if (saved && /^[a-f0-9]{64}$/.test(saved.publicKey) && /^[a-f0-9]{128}$/.test(saved.secretKey) && hex(nacl.sign.keyPair.fromSecretKey(unhex(saved.secretKey)).publicKey) === saved.publicKey) {
      this.publicKey = saved.publicKey; this.secretKey = unhex(saved.secretKey); this.name = saved.name || 'My browser'
    } else {
      const pair = nacl.sign.keyPair(); this.publicKey = hex(pair.publicKey); this.secretKey = pair.secretKey; this.name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : /Macintosh/.test(navigator.userAgent) ? 'Mac browser' : 'My browser'
    }
    try {
      const record = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null') as { requestId?: string; publicKey?: string } | null
      if (record?.publicKey === this.publicKey) this.requestId = record.requestId ?? ''
    } catch { /* a corrupt connection record does not grant access */ }
    this.remember()
    if (location.pathname !== '/room/') history.replaceState(null, '', '/room/#' + token + (host ? '.' + host : ''))
  }
  private remember(): void {
    try { localStorage.setItem('blinky.remote.device.v1', JSON.stringify({ publicKey: this.publicKey, secretKey: hex(this.secretKey), name: this.name })); if (this.requestId) localStorage.setItem(this.storageKey, JSON.stringify({ requestId: this.requestId, publicKey: this.publicKey })) } catch { /* private browsing can keep the current key only in memory */ }
  }
  private sign(text: string): string { return hex(nacl.sign.detached(encode(text), this.secretKey)) }
  private async bootstrap(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await fetch('/api/connect/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + this.invitation, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) throw new RemoteHttpError(response.status, typeof data.error === 'string' ? data.error : 'Connection was not accepted.')
      return data
    } finally { clearTimeout(timer) }
  }
  async challenge(name = this.name): Promise<RemoteChallenge> {
    this.name = name.trim().slice(0, 80)
    if (!this.name) throw new Error('请输入设备名称。 / Enter a device name.')
    const proof = await this.bootstrap('challenge', { name: this.name, publicKey: this.publicKey }) as unknown as RemoteChallenge
    if (proof.publicKey !== this.publicKey || proof.name !== this.name || !/^[a-f0-9]{64}$/.test(proof.hostKey) || this.hostKey && proof.hostKey !== this.hostKey || typeof proof.serverTime !== 'number' || typeof proof.expiresAt !== 'number' || proof.expiresAt <= proof.serverTime || proof.expiresAt - proof.serverTime > 61_000 || !nacl.sign.detached.verify(encode(connectProof(proof.id, proof.challenge, proof.publicKey, proof.hostKey, proof.expiresAt, proof.name, proof.serverTime)), unhex(proof.signature), unhex(proof.hostKey))) throw new Error('主机身份验证失败，请核对邀请。 / Host identity did not match the invitation.')
    this.offset = proof.serverTime - Date.now(); this.remember(); return proof
  }
  async request(name: string): Promise<void> {
    const proof = await this.challenge(name)
    const record = await this.bootstrap('request', { id: proof.id, signature: this.sign(connectProof(proof.id, proof.challenge, proof.publicKey, proof.hostKey, proof.expiresAt, proof.name, proof.serverTime)) })
    if (typeof record.id !== 'string') throw new Error('The connection request was not confirmed.')
    this.requestId = record.id; this.remember()
  }
  hasRequest(): boolean { return !!this.requestId }
  remainingLease(access: RemoteGrant): number { return Math.max(0, access.expiresAt - (Date.now() + this.offset)) }
  async check(refreshClock = false): Promise<{ state: RemoteDeviceState; access?: RemoteGrant }> {
    if (!this.requestId) return { state: 'expired' }
    if (refreshClock) await this.challenge()
    const value = nonce(), time = Math.round(Date.now() + this.offset)
    const result = await this.bootstrap('status', { id: this.requestId, nonce: value, time, signature: this.sign(statusProof(this.requestId, value, time)) })
    if (typeof result.serverTime === 'number') this.offset = result.serverTime - Date.now()
    return { state: result.state as RemoteDeviceState, ...(result.state === 'approved' ? { access: result as unknown as RemoteGrant } : {}) }
  }
  async signed(path: string, body: unknown, access: RemoteGrant, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<unknown> {
    const raw = body === undefined ? '' : JSON.stringify(body), method = body === undefined ? 'GET' : 'POST', time = Math.round(Date.now() + this.offset), value = nonce(), controller = new AbortController()
    const abort = (): void => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, options.timeout ?? 15_000)
    try {
      const response = await fetch(path, { method, headers: { Authorization: 'BlinkyDevice ' + access.grant, 'X-Blinky-Nonce': value, 'X-Blinky-Time': String(time), 'X-Blinky-Signature': this.sign(requestProof(access.grant, value, time, method, path, hash(raw))), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: raw }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) throw new RemoteHttpError(response.status, typeof data.error === 'string' ? data.error : 'The request could not be confirmed.', typeof data.code === 'string' ? data.code : undefined)
      return data
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  }
  messageReceipt(sessionId: string, body: unknown): { id: string; acknowledge: () => void } {
    const key = this.storageKey + '.message.' + hash(sessionId + JSON.stringify(body)), fresh = 'remote-' + hex(nacl.randomBytes(16))
    let id = fresh
    try { const previous = localStorage.getItem(key); if (previous && /^remote-[a-f0-9]{32}$/.test(previous)) id = previous; else localStorage.setItem(key, id) } catch { /* same-page retries still use the in-memory transport cache */ }
    return { id, acknowledge: () => { try { localStorage.removeItem(key) } catch {} } }
  }
}
