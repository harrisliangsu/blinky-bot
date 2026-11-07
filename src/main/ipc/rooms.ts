import type { CollaborationRoom } from '../../shared/types'
import { collaborationOrigin, ensureCollaborationServer, roomInviteUrl, stopCollaborationServer } from '../collaboration/server'
import { invitationQr } from '../collaboration/qr'
import { getSession } from '../store/sessions'
import { removeRoom, roomById, shareRoom, sharedRooms, storedRooms, type StoredRoom } from '../store/rooms'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleEvent, nullResult } from './handler'
import { asId, asString } from './validate'
import { roomAccess } from '../collaboration/access'
import { broadcast } from './broadcast'

function publicRoom(room: StoredRoom): CollaborationRoom { const { token: _token, ...visible } = room; return { ...visible, inviteUrl: roomInviteUrl(room) } }
let mutations: Promise<unknown> = Promise.resolve()
function serial<T>(action: () => Promise<T>): Promise<T> { const result = mutations.then(action, action); mutations = result.catch(() => {}); return result }
export function registerRoomIpc(): void {
  roomAccess.onChange(roomId => broadcast({ type: 'room-devices-changed', roomId }))
  // Host authorization is an explicit current-window user action, never an Agent/native API.
  handleEvent('openbot:rooms:devices', (_event, [id]) => roomAccess.list(asId(id)), emptyArray)
  handleEvent<boolean>('openbot:rooms:decideDevice', async (event, [roomId, deviceId, action, permission, scope]) => {
    if (!event.sender.isFocused() || !await event.senderFrame?.executeJavaScript('navigator.userActivation.isActive')) return false
    if ((scope !== undefined && !['room', 'workspace'].includes(String(scope))) || !['approve', 'deny', 'revoke', 'remove'].includes(String(action)) || (permission !== undefined && !['view', 'control'].includes(String(permission)))) return false
    const room = roomById(asId(roomId))
    return !!room && roomAccess.decide(room, asId(deviceId), action as 'approve' | 'deny' | 'revoke' | 'remove', permission === 'control' ? 'control' : 'view', scope === 'workspace' ? 'workspace' : 'room')
  }, () => false)
  // Discovery/listing must never start a listener or restore an old invitation.
  handle<CollaborationRoom[]>(CHANNELS.roomsList, () => storedRooms().map(publicRoom), emptyArray)
  handle<CollaborationRoom | null>(CHANNELS.roomsCreate, ([sessionId, name, permission]) => serial(async () => {
    const session = getSession(asId(sessionId)); if (!session) return null
    if (permission !== undefined && permission !== 'view' && permission !== 'control') throw new Error('Invalid room permission')
    const label = name === undefined ? session.title : asString(name, 200)
    // Only report sharing enabled after the listener actually exists.
    await ensureCollaborationServer()
    return publicRoom(shareRoom(session.id, label, permission ?? 'control'))
  }), nullResult)
  handle<boolean>(CHANNELS.roomsRemove, ([id]) => serial(async () => {
    roomAccess.revokeRoom(asId(id))
    removeRoom(asId(id))
    if (sharedRooms().length === 0) await stopCollaborationServer()
    return roomById(asId(id)) === null
  }), () => false)
  handle<string | null>('openbot:rooms:qr', async ([id]) => {
    const room = roomById(asId(id)), invite = room && collaborationOrigin() ? roomInviteUrl(room) : ''
    if (!invite) return null
    const data = await invitationQr(invite)
    return roomById(asId(id))?.enabled && roomInviteUrl(roomById(asId(id))!) === invite ? data : null
  }, nullResult)
}
