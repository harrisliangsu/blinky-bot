import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { RecoveryFile } from './recoveryFile'
import type { Attachment } from '../../shared/types'
import { dataRoot } from '../store/paths'
import { RoomAccessError } from './access'
import { REMOTE_MAX_FILE_BYTES, REMOTE_MAX_ATTACHMENTS, validRemoteBase64 } from '../../shared/remoteAttachments'

const uploads = new Map<string, { owner: string; path: string; name: string; size: number; used: boolean; expires: number }>()
let loadedRoot = ''
const uploadPath = (owner: string, id: string, name: string): string => join(dataRoot(), 'remote-uploads', createHash('sha256').update(owner).digest('hex').slice(0, 24), id + '-' + name)
const registry = (): RecoveryFile => new RecoveryFile(join(dataRoot(), 'remote-upload-recovery.json'), createRequire(import.meta.url)('electron').safeStorage ?? { isEncryptionAvailable: () => false })
function loadUploads(): void {
  if (loadedRoot === dataRoot()) return
  loadedRoot = dataRoot(); uploads.clear()
  try {
    const entries = registry().read() as { id: string; owner: string; name: string; size: number; used: boolean; expires: number }[] | null
    if (!Array.isArray(entries) || entries.length > 256) return
    for (const entry of entries) if (/^[a-f0-9]{48}$/.test(entry.id) && typeof entry.owner === 'string' && entry.owner.length <= 256 && typeof entry.name === 'string' && entry.name.length <= 200 && entry.name === basename(entry.name.replaceAll('\\', '/')) && !/[\x00-\x1f\x7f]/.test(entry.name) && Number.isInteger(entry.size) && entry.size >= 0 && entry.size <= REMOTE_MAX_FILE_BYTES && Number.isSafeInteger(entry.expires) && entry.expires > Date.now() && entry.expires <= Date.now() + 60 * 60_000) uploads.set(entry.id, { ...entry, path: uploadPath(entry.owner, entry.id, entry.name) })
  } catch { /* no plaintext fallback; unavailable references ask for re-selection */ }
}
function saveUploads(): void { try { registry().write([...uploads].map(([id, { path: _path, ...entry }]) => ({ id, ...entry }))) } catch { /* temporary uploads remain usable within this process */ } }
const MAX_FILE = REMOTE_MAX_FILE_BYTES
export async function uploadRemoteFile(owner: string, input: unknown, allowed: () => boolean): Promise<string> {
  loadUploads()
  const value = input as { name?: unknown; data?: unknown } | null
  if (!value || typeof value.name !== 'string' || typeof value.data !== 'string' || value.data.length > MAX_FILE * 4 / 3 || !validRemoteBase64(value.data)) throw new RoomAccessError(400, 'Choose a file up to 6 MB.')
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
  saveUploads()
  return 'blinky-upload:' + id + '/' + encodeURIComponent(name)
}

/** A browser can reference only its own uploaded files, never a host path. */
export function remoteAttachments(owner: string, input: unknown): Attachment[] {
  loadUploads()
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > REMOTE_MAX_ATTACHMENTS) throw new RoomAccessError(400, 'Invalid attachments.')
  return input.map(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 255 || typeof raw.name !== 'string') throw new RoomAccessError(400, 'Invalid attachment.')
    if (raw.kind === 'file' || raw.kind === 'image' && typeof raw.path === 'string') {
      const id = typeof raw.path === 'string' ? /^blinky-upload:([a-f0-9]{48})\//.exec(raw.path)?.[1] : undefined, file = id ? uploads.get(id) : undefined
      if (!file || file.owner !== owner || file.expires < Date.now()) throw new RoomAccessError(403, 'Upload this file again before sending.')
      try { const stat = lstatSync(file.path); if (!stat.isFile() || stat.size !== file.size) throw new Error('Unavailable upload') } catch { throw new RoomAccessError(403, 'The uploaded file is unavailable. Choose it again before sending.') }
      file.used = true
      saveUploads()
      if (raw.kind === 'image') {
        if (typeof raw.mime !== 'string' || !/^image\/(?:png|jpeg|gif|webp)$/.test(raw.mime)) throw new RoomAccessError(400, 'Unsupported image type.')
        return { id: raw.id, kind: 'image', name: file.name, mime: raw.mime, data: readFileSync(file.path).toString('base64') }
      }
      return { id: raw.id, kind: 'file', name: file.name, path: file.path }
    }
    if (raw.path !== undefined || typeof raw.data !== 'string' || raw.data.length > 8 * 1024 * 1024) throw new RoomAccessError(400, 'Invalid browser attachment.')
    if (raw.kind === 'image' && /^image\/(?:png|jpeg|gif|webp)$/.test(raw.mime) && /^[A-Za-z0-9+/]+={0,2}$/.test(raw.data) && raw.data.length % 4 === 0) return { id: raw.id, kind: 'image', name: raw.name.slice(0, 255), mime: raw.mime, data: raw.data }
    if (raw.kind === 'selection') return { id: raw.id, kind: 'selection', name: raw.name.slice(0, 255), data: raw.data }
    throw new RoomAccessError(400, 'This attachment type is unavailable.')
  })
}
