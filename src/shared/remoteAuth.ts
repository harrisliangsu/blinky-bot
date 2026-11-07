/** Versioned signed envelopes shared by the browser and native host. */
export const remoteAuthVersion = 'blinky-device-v1'
export const connectProof = (id: string, challenge: string, publicKey: string, hostKey: string, expiresAt: number, name: string, serverTime: number): string =>
  JSON.stringify([remoteAuthVersion, 'connect', id, challenge, publicKey, hostKey, expiresAt, name, serverTime])
export const statusProof = (id: string, nonce: string, time: number): string =>
  JSON.stringify([remoteAuthVersion, 'status', id, nonce, time])
export const requestProof = (grant: string, nonce: string, time: number, method: string, target: string, bodyHash: string): string =>
  JSON.stringify([remoteAuthVersion, 'request', grant, nonce, time, method, target, bodyHash])

export type RemoteAccessScope = 'room' | 'workspace'
export type RemoteDeviceState = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'
export interface RemoteDevice {
  id: string
  roomId: string
  sessionId: string
  name: string
  fingerprint: string
  state: RemoteDeviceState
  permission: 'view' | 'control'
  scope: RemoteAccessScope
  requestedAt: number
  expiresAt: number
}
export interface RemoteChallenge {
  id: string
  challenge: string
  publicKey: string
  name: string
  hostKey: string
  expiresAt: number
  serverTime: number
  signature: string
}
