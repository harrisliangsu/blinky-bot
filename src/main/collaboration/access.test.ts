import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import { RoomAccess, type AccessRoom } from './access.ts'
import { connectProof, requestProof, statusProof, type RemoteChallenge } from '../../shared/remoteAuth.ts'
const room: AccessRoom = { id: 'one', sessionId: 'conversation-one', token: 'synthetic-invite-one', enabled: true, permission: 'control' }
const key = () => { const pair = nacl.sign.keyPair(); return { publicKey: Buffer.from(pair.publicKey).toString('hex'), secret: pair.secretKey } }
const sign = (text: string, secret: Uint8Array) => Buffer.from(nacl.sign.detached(Buffer.from(text), secret)).toString('hex')
const connect = (auth: RoomAccess, client: ReturnType<typeof key>, scope = room, name = 'Synthetic phone') => {
  const p = auth.challenge(scope, client.publicKey, name)
  assert.equal(nacl.sign.detached.verify(Buffer.from(connectProof(p.id, p.challenge, p.publicKey, p.hostKey, p.expiresAt, p.name, p.serverTime)), Buffer.from(p.signature, 'hex'), Buffer.from(p.hostKey, 'hex')), true)
  const signature = sign(connectProof(p.id, p.challenge, p.publicKey, p.hostKey, p.expiresAt, p.name, p.serverTime), client.secret)
  return { p, signature, id: auth.request(scope, p.id, signature).id }
}
const status = (auth: RoomAccess, client: ReturnType<typeof key>, id: string, now: number, scope = room) => {
  const nonce = randomBytes(32).toString('hex')
  return auth.status(scope, id, nonce, now, sign(statusProof(id, nonce, now), client.secret))
}
const proof = (client: ReturnType<typeof key>, grant: string, now: number, target = '/api/room', method = 'GET', body = '') => {
  const nonce = randomBytes(32).toString('hex'), digest = createHash('sha512').update(body).digest('hex')
  return { nonce, time: now, signature: sign(requestProof(grant, nonce, now, method, target, digest), client.secret), target, method, body }
}
const authorize = (auth: RoomAccess, grant: string, p: ReturnType<typeof proof>, scope = room) => auth.authorize(grant, p.nonce, p.time, p.signature, p.method, p.target, p.body, id => id === scope.id ? scope : null)

test('possession of an invite, a name, or a device id never grants access without explicit host approval', () => {
  const now = 1_000_000, auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  assert.equal(status(auth, client, request.id, now).state, 'pending')
  assert.throws(() => authorize(auth, request.id, proof(client, request.id, now)), { status: 401 })
  assert.equal(auth.decide(room, request.id, 'approve', 'control'), true)
  const approved = status(auth, client, request.id, now)
  assert.equal(approved.state, 'approved')
  const grant = approved.grant!
  assert.equal(authorize(auth, grant, proof(client, grant, now)).room.sessionId, room.sessionId)
  const impostor = key()
  assert.throws(() => authorize(auth, grant, proof(impostor, grant, now)), { status: 401 })
  const second = connect(auth, impostor, room, 'Synthetic phone')
  assert.equal(status(auth, impostor, second.id, now).state, 'pending')
  assert.notEqual(auth.list(room.id)[0]!.fingerprint, auth.list(room.id)[1]!.fingerprint)
})
test('proofs bind method, target, body and one-use nonce; reconnect requires the same private key', () => {
  const now = 1_000_000, auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  auth.decide(room, request.id, 'approve', 'view'); const grant = status(auth, client, request.id, now).grant!
  const p = proof(client, grant, now)
  assert.equal(authorize(auth, grant, p).permission, 'view')
  assert.throws(() => authorize(auth, grant, p), { status: 401 })
  for (const change of [{ target: '/api/room/message' }, { method: 'POST' }, { body: 'changed' }]) assert.throws(() => authorize(auth, grant, { ...proof(client, grant, now), ...change }), { status: 401 })
  assert.equal(status(auth, client, connect(auth, client).id, now).grant, grant)
})
test('denial and revocation survive new challenges, while an explicit host decision can restore access', () => {
  const now = 1_000_000, auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  auth.decide(room, request.id, 'deny');assert.equal(status(auth, client, request.id, now).state, 'denied')
  assert.equal(connect(auth, client).id, request.id)
  auth.decide(room, request.id, 'approve', 'control');const first = status(auth, client, request.id, now).grant!
  auth.decide(room, request.id, 'revoke');assert.throws(() => authorize(auth, first, proof(client, first, now)), { status: 401 })
  assert.equal(status(auth, client, connect(auth, client).id, now).state, 'revoked')
  auth.decide(room, request.id, 'approve', 'view');const next = status(auth, client, request.id, now).grant!
  assert.notEqual(next, first);assert.equal(authorize(auth, next, proof(client, next, now)).permission, 'view')
})
test('expiry, room rotation, disabled rooms and process restart close authorization', () => {
  let now = 1_000_000;const auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  auth.decide(room, request.id, 'approve', 'control');const grant = status(auth, client, request.id, now).grant!
  for (const changed of [{ ...room, token: 'rotated' }, { ...room, enabled: false }, { ...room, sessionId: 'other-conversation' }]) assert.throws(() => authorize(auth, grant, proof(client, grant, now), changed), { status: 401 })
  assert.throws(() => authorize(new RoomAccess(() => now), grant, proof(client, grant, now)), { status: 401 })
  now += 8 * 60 * 60_000;assert.throws(() => authorize(auth, grant, proof(client, grant, now)), { status: 401 })
  const fresh = connect(auth, client);assert.notEqual(fresh.id, request.id);assert.equal(status(auth, client, fresh.id, now).state, 'pending')
})
test('tampered challenges, spoofed signatures, concurrent clients and downgraded room permissions', () => {
  const now = 1_000_000, auth = new RoomAccess(() => now), clients = [key(), key()]
  const p = auth.challenge(room, clients[0]!.publicKey, 'Synthetic device')
  assert.throws(() => auth.request(room, p.id, sign(connectProof(p.id, p.challenge, p.publicKey, p.hostKey, p.expiresAt, p.name, p.serverTime), clients[1]!.secret)), { status: 401 })
  const requests = clients.map(c => connect(auth, c));for(const r of requests) auth.decide(room, r.id, 'approve', 'control')
  requests.forEach((r,i) => { const grant = status(auth, clients[i]!, r.id, now).grant!;assert.equal(authorize(auth, grant, proof(clients[i]!, grant, now), { ...room, permission: 'view' }).permission, 'view') })
  assert.throws(() => auth.challenge(room, 'not-a-key', 'Name'), { status: 400 })
})

test('encrypted snapshot restores the same host/device within the original lease; old process grants cannot replay', () => {
  let now = 1_000_000
  const auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  auth.decide(room, request.id, 'approve', 'control', 'workspace')
  const before = status(auth, client, request.id, now), host = auth.hostKey(room), snapshot = auth.snapshot()
  now += 60_000
  const next = new RoomAccess(() => now); next.restore(snapshot, [room])
  const restored = status(next, client, request.id, now)
  assert.equal(next.hostKey(room), host); assert.equal(restored.expiresAt, before.expiresAt)
  assert.equal(restored.scope, 'workspace'); assert.equal(restored.permission, 'control'); assert.notEqual(restored.grant, before.grant)
  assert.throws(() => authorize(next, before.grant!, proof(client, before.grant!, now)), { status: 401 })
  assert.equal(authorize(next, restored.grant!, proof(client, restored.grant!, now)).deviceId, request.id)
  assert.throws(() => authorize(next, restored.grant!, proof(key(), restored.grant!, now)), { status: 401 })
  for (const action of ['deny', 'revoke'] as const) {
    next.decide(room, request.id, action)
    const reboot = new RoomAccess(() => now); reboot.restore(next.snapshot(), [room])
    assert.equal(status(reboot, client, connect(reboot, client).id, now).state, action === 'deny' ? 'denied' : 'revoked')
  }
  const expired = new RoomAccess(() => before.expiresAt! + 1); expired.restore(snapshot, [room])
  assert.equal(status(expired, client, request.id, before.expiresAt! + 1).state, 'expired')
  const stopped = new RoomAccess(() => now); stopped.restore(snapshot, [])
  assert.throws(() => status(stopped, client, request.id, now), { status: 401 })
  const rotated = new RoomAccess(() => now); rotated.restore(snapshot, [{ ...room, token: 'new-invite' }])
  assert.throws(() => status(rotated, client, request.id, now, { ...room, token: 'new-invite' }), { status: 401 })
})

test('a failed durable consent write is not acknowledged and does not change live authorization', () => {
  const now = 1_000_000, auth = new RoomAccess(() => now), client = key(), request = connect(auth, client)
  auth.onPersist(() => { throw new Error('Synthetic disk failure') })
  assert.throws(() => auth.decide(room, request.id, 'approve', 'control'), /disk failure/)
  assert.equal(status(auth, client, request.id, now).state, 'pending')
  auth.onPersist(() => {})
  auth.decide(room, request.id, 'approve', 'view', 'room')
  auth.onPersist(() => { throw new Error('Synthetic disk failure') })
  assert.throws(() => auth.decide(room, request.id, 'approve', 'control', 'workspace'), /disk failure/)
  const after = status(auth, client, request.id, now)
  assert.equal(after.permission, 'view'); assert.equal(after.scope, 'room')
  assert.throws(() => auth.decide(room, request.id, 'revoke'), /disk failure/)
  assert.equal(status(auth, client, request.id, now).state, 'approved')
})
