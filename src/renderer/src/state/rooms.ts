import type { CollaborationRoom } from '../../../shared/types'
import { bridge, errText } from './bridge'
import { store } from './core'

export async function loadRooms(): Promise<void> {
  try { store.patch({ rooms: await bridge().rooms.list() }) }
  catch (error) { store.toast(errText(error), 'error') }
}
/**
 * Share a chat, or start serving a room that was created in an earlier run.
 *
 * The returned room replaces any entry with the same id rather than being
 * prepended blindly: sharing a chat that already has a room re-opens that room,
 * so prepending listed the same room twice — once serving, once stale.
 */
export async function createRoom(sessionId: string, name?: string, permission?: 'view' | 'control'): Promise<CollaborationRoom | null> {
  try {
    const room = await bridge().rooms.create(sessionId, name, permission)
    if (room) store.patch({ rooms: [room, ...store.getState().rooms.filter((entry) => entry.id !== room.id)] })
    return room
  } catch (error) { store.toast(errText(error), 'error'); return null }
}
export async function removeRoom(id: string): Promise<boolean> {
  try { if (!await bridge().rooms.remove(id)) throw new Error('Sharing could not be stopped.'); store.patch({ rooms: store.getState().rooms.filter((room) => room.id !== id) }); return true }
  catch (error) { store.toast(errText(error), 'error'); return false }
}
