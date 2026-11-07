import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Attachment } from '../../shared/types'
import { dataRoot } from '../store/paths'
import { RoomAccessError } from './access'

const uploads = new Map<string, { owner: string; path: string; name: string; size: number; used: boolean; expires: number }>()
const MAX_FILE = 6 * 1024 * 1024
export async function uploadRemoteFile(owner: string, input: unknown, allowed: () => boolean): Promise<string> {
  const value = input as { name?: unknown; data?: unknown } | null
  if (!value || typeof value.name !== 'string' || typeof value.data !== 'string' || value.data.length > MAX_FILE * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new RoomAccessError(400, 'Choose a file up to 6 MB.')
  for (const [id, item] of uploads) if (item.expires < Date.now()) { uploads.delete(id); if (!item.used) void unlink(item.path).catch(() => {}) }
  const owned = [...uploads.values()].filter(item => item.owner === owner)
  if (uploads.size >= 256 || owned.reduce((sum, item) => sum + item.size, 0) > 48 * 1024 * 1024) throw new RoomAccessError(429, 'The browser upload allowance is full. Try later.')
  const name = basename(value.name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'attachment'
  const id = randomBytes(24).toString('hex'), directory = join(dataRoot(), 'remote-uploads', createHash('sha256').update(owner).digest('hex').slice(0, 24)), path = join(directory, id + '-' + name)
  if (!allowed()) throw new RoomAccessError(401, 'Device access was revoked.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, Buffer.from(value.data, 'base64'), { flag: 'wx', mode: 0o600 })
  if (!allowed()) { await unlink(path); throw new RoomAccessError(401, 'Device access was revoked.') }
  uploads.set(id, { owner, path, name, size: Buffer.byteLength(value.data, 'base64'), used: false, expires: Date.now() + 60 * 60_000 })
  return 'blinky-upload:' + id + '/' + encodeURIComponent(name)
}

/** A browser can reference only its own uploaded files, never a host path. */
export function remoteAttachments(owner: string, input: unknown): Attachment[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 12) throw new RoomAccessError(400, 'Invalid attachments.')
  return input.map(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 255 || typeof raw.name !== 'string') throw new RoomAccessError(400, 'Invalid attachment.')
    if (raw.kind === 'file') {
      const id = typeof raw.path === 'string' ? /^blinky-upload:([a-f0-9]{48})\//.exec(raw.path)?.[1] : undefined, file = id ? uploads.get(id) : undefined
      if (!file || file.owner !== owner || file.expires < Date.now()) throw new RoomAccessError(403, 'Upload this file again before sending.')
      file.used = true
      return { id: raw.id, kind: 'file', name: file.name, path: file.path }
    }
    if (raw.path !== undefined || typeof raw.data !== 'string' || raw.data.length > 8 * 1024 * 1024) throw new RoomAccessError(400, 'Invalid browser attachment.')
    if (raw.kind === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(raw.mime) && /^[A-Za-z0-9+/]+={0,2}$/.test(raw.data) && raw.data.length % 4 === 0) return { id: raw.id, kind: 'image', name: raw.name.slice(0, 255), mime: raw.mime, data: raw.data }
    if (raw.kind === 'selection') return { id: raw.id, kind: 'selection', name: raw.name.slice(0, 255), data: raw.data }
    throw new RoomAccessError(400, 'This attachment type is unavailable.')
  })
}
