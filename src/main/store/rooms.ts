import { randomBytes, randomUUID } from 'node:crypto'
import type { CollaborationRoom } from '../../shared/types'
import { JsonCollection } from './collection'
import { roomsDir } from './paths'

export interface StoredRoom extends Omit<CollaborationRoom, 'inviteUrl'> { token: string }
const collection = new JsonCollection<StoredRoom>(roomsDir, normalise)

/*
 * A stored room always comes back disabled.
 *
 * An old room document is not consent to resume a listener. Only the separate
 * OS-encrypted recovery record created by an explicit share can restore it.
 * Listing rooms never starts a server; upgrades do not enable old invitations.
 */
function normalise(raw: unknown): StoredRoom | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value['id'] !== 'string' || typeof value['sessionId'] !== 'string' || typeof value['token'] !== 'string') return null
  const createdAt = Number(value['createdAt']) || Date.now()
  return { id: value['id'], sessionId: value['sessionId'], token: value['token'], name: typeof value['name'] === 'string' ? value['name'].slice(0, 200) : 'Shared room', enabled: false, permission: value['permission'] === 'view' ? 'view' : 'control', createdAt, sharedFrom: Number(value['sharedFrom']) || createdAt }
}

export const loadRooms = (): Promise<void> => collection.load()
export const storedRooms = (): StoredRoom[] => collection.all().sort((a, b) => b.createdAt - a.createdAt)
export const roomById = (id: string): StoredRoom | null => collection.get(id)
export function restoreRoomSharing(id: string): void { const room = collection.get(id); if (room) collection.adopt({ ...room, enabled: true }) }
export function restoreRoomDocument(room: StoredRoom): void { collection.put(room) }

/** Rooms the user is sharing right now. Empty means nothing needs a listener. */
export const sharedRooms = (): StoredRoom[] => collection.all().filter((room) => room.enabled)

/*
 * The one lookup the HTTP server may use: the token must match AND the room
 * must be one the user is currently sharing.
 *
 * Enabled is checked here rather than in each handler because a handler that
 * forgets hands a stopped-but-not-deleted room's invite URL a working page,
 * transcript and message endpoint for the rest of the app's life.
 */
export const sharedRoomByToken = (token: string): StoredRoom | null => collection.all().find((room) => room.token === token && room.enabled) ?? null

/*
 * Start (or restart) sharing a session, and hand back the room to publish.
 *
 * A session keeps one room: pressing the share button again re-opens the room
 * it already has rather than minting a second token, and a disabled room receives a fresh invitation when re-enabled — and there is exactly one
 * link per conversation to revoke.
 *
 * `sharedFrom` moves to now whenever a room goes from off to on, limiting live
 * question controls. Public history belongs to the explicitly invited session;
 * old tokens never regain access when a fresh invitation is issued.
 */
export function shareRoom(sessionId: string, name: string, permission: 'view' | 'control' = 'control'): StoredRoom {
  const now = Date.now()
  const existing = collection.all().find((room) => room.sessionId === sessionId)
  const wanted = name.trim().slice(0, 200)
  if (existing) return collection.put({ ...existing, name: wanted || existing.name, permission, token: existing.enabled ? existing.token : randomBytes(24).toString('base64url'), enabled: true, sharedFrom: existing.enabled ? existing.sharedFrom : now })
  return collection.put({ id: randomUUID(), sessionId, name: wanted || 'Shared room', permission, token: randomBytes(24).toString('base64url'), enabled: true, createdAt: now, sharedFrom: now })
}

export const removeRoom = (id: string): boolean => collection.delete(id)
