import { safeStorage } from 'electron'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { dataRoot } from '../store/paths'
import { restoreRoomSharing, sharedRooms, roomById } from '../store/rooms'
import { roomAccess, type AccessSnapshot } from './access'
import { RecoveryFile } from './recoveryFile'

interface Endpoint { address: string; port: number }
interface RecoveryDocument { version: 1; endpoint: Endpoint; rooms: { id: string; sessionId: string; token: string }[]; access: AccessSnapshot }
export type SharingRecoveryState = 'saved' | 'unavailable' | 'address-changed' | 'port-unavailable'
let file: RecoveryFile | undefined, endpoint: Endpoint | undefined, durable = false, loaded = false
let state: SharingRecoveryState = 'unavailable'
const snapshot = (exclude?: string): RecoveryDocument => {
  if (!endpoint) throw new Error('The sharing listener is unavailable.')
  const rooms = sharedRooms().filter(room => room.id !== exclude).map(({ id, sessionId, token }) => ({ id, sessionId, token }))
  return { version: 1, endpoint, rooms, access: roomAccess.snapshot() }
}
export function loadSharingRecovery(): void {
  if (loaded) return
  loaded = true; file = new RecoveryFile(join(dataRoot(), 'sharing-recovery.json'), safeStorage)
  try {
    const value = file.read() as RecoveryDocument | null
    if (value) {
      if (value.version !== 1 || !value.endpoint || isIP(value.endpoint.address) !== 4 || !Number.isInteger(value.endpoint.port) || value.endpoint.port < 1024 || value.endpoint.port > 65535 || !Array.isArray(value.rooms) || value.rooms.length > 256 || !Array.isArray(value.access?.identities) || !Array.isArray(value.access.devices) || value.access.devices.length > 16384) throw new Error('Invalid saved sharing')
      const rooms = value.rooms.flatMap(binding => {
        const room = roomById(binding.id)
        return room && room.sessionId === binding.sessionId && room.token === binding.token ? [{ ...room, enabled: true }] : []
      })
      roomAccess.restore(value.access, rooms)
      for (const room of rooms) restoreRoomSharing(room.id)
      endpoint = value.endpoint; durable = true; state = 'saved'
    }
  } catch { state = 'unavailable'; console.warn('[blinky/remote] saved sharing is unavailable; no listener or device approval was restored') }
  roomAccess.onPersist(() => { if (durable) file!.write(snapshot()) })
}
export function sharingEndpoint(): Endpoint | undefined { return endpoint }
export function setSharingEndpoint(next: Endpoint): void {
  const previous = endpoint; endpoint = next
  try { if (durable) file!.write(snapshot()); state = durable ? 'saved' : 'unavailable' } catch (error) { endpoint = previous; throw error }
}
/** A new explicit share may establish recovery; failure retains temporary sharing. */
export function rememberSharing(): void {
  try { file!.write(snapshot()); durable = true; state = 'saved' }
  catch { state = 'unavailable'; if (durable) throw new Error('Sharing changes could not be saved. Retry on the Mac.'); console.warn('[blinky/remote] sharing is temporary because secure recovery is unavailable') }
}
/** A persisted stop is authoritative even if an old room document remains. */
export function forgetSharing(id: string): void { if (durable) file!.write(snapshot(id)) }
export function sharingRecoveryState(): SharingRecoveryState { return state }
export function sharingRecoveryFailure(reason: SharingRecoveryState): void { state = reason }
