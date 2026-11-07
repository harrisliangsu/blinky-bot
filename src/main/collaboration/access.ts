/** Device key possession plus explicit host consent. Invitation possession is bootstrap only. */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import type { RemoteAccessScope, RemoteChallenge, RemoteDevice } from '../../shared/remoteAuth'
import { connectProof, requestProof, statusProof } from '../../shared/remoteAuth'

export interface AccessRoom { id: string; sessionId: string; token: string; enabled: boolean; permission: 'view' | 'control' }
interface ChallengeRecord { room: AccessRoom; scope: string; name: string; proof: RemoteChallenge }
interface DeviceRecord { public: RemoteDevice; scope: string; key: string; grant: string; nonces: Map<string, number> }
const hex = (value: unknown, size: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value)
const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')
const digest = (text: string): string => createHash('sha512').update(text).digest('hex')
const scope = (room: AccessRoom): string => createHash('sha256').update(JSON.stringify([room.id, room.sessionId, room.token])).digest('hex')
const publicKey = (key: string): KeyObject => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'spki' })
function validSignature(key: string, payload: string, signature: unknown): boolean {
  try { return hex(signature, 128) && verify(null, bytes(payload), publicKey(key), Buffer.from(signature, 'hex')) }
  catch { return false }
}
export class RoomAccessError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export class RoomAccess {
  private readonly challenges = new Map<string, ChallengeRecord>()
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly identities = new Map<string, { secret: KeyObject; key: string }>()
  private readonly listeners = new Set<(roomId: string) => void>()
  constructor(private readonly clock: () => number = Date.now) {}
  onChange(listener: (roomId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private changed(roomId: string): void { for (const listener of this.listeners) { try { listener(roomId) } catch { /* an observer cannot approve or break authentication */ } } }
  hostKey(room: AccessRoom): string {
    const id = scope(room), previous = this.identities.get(id)
    if (previous) return previous.key
    const pair = generateKeyPairSync('ed25519'), key = (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex')
    this.identities.set(id, { secret: pair.privateKey, key }); return key
  }
  challenge(room: AccessRoom, key: unknown, name: unknown): RemoteChallenge {
    if (!room.enabled || !hex(key, 64) || typeof name !== 'string' || !name.trim() || name.length > 80) throw new RoomAccessError(400, 'Enter a device name and valid device identity.')
    const now = this.clock()
    for (const [id, entry] of this.challenges) if (entry.proof.expiresAt <= now) this.challenges.delete(id)
    if (this.challenges.size >= 512) throw new RoomAccessError(429, 'Too many connection attempts. Try later.')
    const cleanName = name.trim().replace(/[\x00-\x1f\x7f]/g, ' ')
    const id = 'device-' + randomBytes(24).toString('base64url'), challenge = randomBytes(32).toString('hex'), hostKey = this.hostKey(room), expiresAt = now + 60_000
    const signature = sign(null, bytes(connectProof(id, challenge, key, hostKey, expiresAt, cleanName, now)), this.identities.get(scope(room))!.secret).toString('hex')
    const proof = { id, challenge, publicKey: key, name: cleanName, hostKey, expiresAt, serverTime: now, signature }
    this.challenges.set(id, { room: { ...room }, scope: scope(room), name: cleanName, proof })
    return proof
  }
  request(room: AccessRoom, id: unknown, signature: unknown): { id: string } {
    const record = typeof id === 'string' ? this.challenges.get(id) : undefined
    if (!record || !room.enabled || record.scope !== scope(room) || record.proof.expiresAt <= this.clock()) throw new RoomAccessError(401, 'Connection challenge expired. Start again.')
    const p = record.proof
    if (!validSignature(p.publicKey, connectProof(p.id, p.challenge, p.publicKey, p.hostKey, p.expiresAt, p.name, p.serverTime), signature)) throw new RoomAccessError(401, 'Device identity could not be verified.')
    this.challenges.delete(p.id)
    // A fresh challenge cannot silently undo a host denial or revocation.
    const existing = [...this.devices.values()].find(item => item.scope === record.scope && item.key === p.publicKey)
    if (existing && this.state(existing).state !== 'expired') return { id: existing.public.id }
    if (existing) this.devices.delete(existing.public.id)
    if ([...this.devices.values()].filter(item => item.scope === record.scope).length >= 64) throw new RoomAccessError(429, 'The host must remove old devices before accepting more.')
    const device: RemoteDevice = { id: p.id, roomId: room.id, sessionId: room.sessionId, name: record.name, fingerprint: createHash('sha512').update(Buffer.from(p.publicKey, 'hex')).digest('hex').slice(0, 64), state: 'pending', permission: 'view', scope: 'workspace', requestedAt: this.clock(), expiresAt: this.clock() + 5 * 60_000 }
    this.devices.set(p.id, { public: device, scope: record.scope, key: p.publicKey, grant: '', nonces: new Map() }); this.changed(room.id)
    return { id: p.id }
  }
  private state(record: DeviceRecord): RemoteDevice {
    if (record.public.expiresAt <= this.clock() && ['pending', 'approved'].includes(record.public.state)) record.public.state = 'expired'
    return { ...record.public }
  }
  list(roomId: string): RemoteDevice[] { return [...this.devices.values()].filter(item => item.public.roomId === roomId).map(item => this.state(item)) }
  decide(room: AccessRoom, id: string, action: 'approve' | 'deny' | 'revoke' | 'remove', permission: 'view' | 'control' = 'view', accessScope: RemoteAccessScope = 'room'): boolean {
    const record = this.devices.get(id)
    if (!record || record.scope !== scope(room) || !room.enabled) return false
    if (action === 'remove') { this.devices.delete(id); this.changed(room.id); return true }
    const state = this.state(record)
    if (action === 'approve') {
      if (state.state === 'expired') return false
      record.public.state = 'approved'; record.public.scope = accessScope; record.public.permission = permission === 'control' && room.permission === 'control' ? 'control' : 'view'
      record.public.expiresAt = this.clock() + 8 * 60 * 60_000; record.grant = randomBytes(32).toString('base64url'); record.nonces.clear()
    } else if (action === 'deny') record.public.state = 'denied'
    else record.public.state = 'revoked'
    this.changed(room.id); return true
  }
  private proof(record: DeviceRecord, nonce: unknown, time: unknown, signature: unknown, payload: (nonce: string, time: number) => string): void {
    if (!hex(nonce, 64) || typeof time !== 'number' || !Number.isSafeInteger(time) || Math.abs(this.clock() - time) > 45_000 || !validSignature(record.key, payload(nonce, time), signature)) throw new RoomAccessError(401, 'Device proof expired or invalid. Reconnect.')
    for (const [id, expiry] of record.nonces) if (expiry <= this.clock()) record.nonces.delete(id)
    if (record.nonces.has(nonce)) throw new RoomAccessError(401, 'This device request was already used.')
    if (record.nonces.size >= 4096) throw new RoomAccessError(429, 'Too many device requests. Wait before retrying.')
    record.nonces.set(nonce, this.clock() + 90_000)
  }
  status(room: AccessRoom, id: unknown, nonce: unknown, time: unknown, signature: unknown) {
    const record = typeof id === 'string' ? this.devices.get(id) : undefined
    if (!record || record.scope !== scope(room) || !room.enabled) throw new RoomAccessError(401, 'This connection is inactive.')
    this.proof(record, nonce, time, signature, (n, t) => statusProof(record.public.id, n, t))
    const device = this.state(record)
    return { state: device.state, serverTime: this.clock(), ...(device.state === 'approved' ? { grant: record.grant, permission: room.permission === 'view' ? 'view' as const : device.permission, scope: device.scope, expiresAt: device.expiresAt, roomId: room.id, sessionId: room.sessionId } : {}) }
  }
  authorize(grant: unknown, nonce: unknown, time: unknown, signature: unknown, method: string, target: string, body: string, lookup: (id: string) => AccessRoom | null) {
    const record = typeof grant === 'string' ? [...this.devices.values()].find(item => item.grant === grant && !!grant) : undefined
    const room = record ? lookup(record.public.roomId) : null
    if (!record || !room || !room.enabled || record.scope !== scope(room) || this.state(record).state !== 'approved') throw new RoomAccessError(401, 'Host approval is required for this device.')
    this.proof(record, nonce, time, signature, (n, t) => requestProof(record.grant, n, t, method, target, digest(body)))
    return { room, deviceId: record.public.id, deviceName: record.public.name, grant: record.grant, scope: record.public.scope, permission: room.permission === 'view' ? 'view' as const : record.public.permission, expiresAt: record.public.expiresAt }
  }
  stillApproved(deviceId: string, room: AccessRoom, grant?: string, permission?: 'control'): boolean {
    const record = this.devices.get(deviceId)
    return !!record && room.enabled && record.scope === scope(room) && this.state(record).state === 'approved' && (!grant || record.grant === grant) && (!permission || (record.public.permission === 'control' && room.permission === 'control'))
  }
  hasWorkspaceAccess(roomId: string): boolean { return [...this.devices.values()].some(entry => entry.public.roomId === roomId && entry.public.scope === 'workspace' && this.state(entry).state === 'approved') }
  revokeRoom(roomId: string): void {
    for (const entry of this.devices.values()) if (entry.public.roomId === roomId) entry.public.state = 'revoked'
    for (const [id, entry] of this.challenges) if (entry.room.id === roomId) this.challenges.delete(id)
    this.changed(roomId)
  }
  clear(): void { const rooms = new Set([...this.devices.values()].map(item => item.public.roomId)); this.devices.clear(); this.challenges.clear(); this.identities.clear(); for (const id of rooms) this.changed(id) }
}

export const roomAccess = new RoomAccess()
