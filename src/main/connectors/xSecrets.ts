/** User-authorized X credentials are encrypted by the OS and stay in the main process. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { dataRoot } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'

export interface XCredentials { clientId: string; refreshToken: string; userId: string; username: string }
let override: SafeStorage | null | undefined
let queue: Promise<unknown> = Promise.resolve()
export function setXStorageForTests(value: SafeStorage | null | undefined): void { override = value }
function storage(): SafeStorage {
  let api = override
  if (api === undefined) { try { const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string; api = typeof electron === 'object' ? electron.safeStorage ?? null : null } catch { api = null } }
  if (!api?.isEncryptionAvailable()) throw new Error('System encryption is unavailable.')
  return api
}
function file(): string { return join(dataRoot(), 'x-connection.json') }
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }
function parse(raw: unknown): XCredentials {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid X connection.')
  const v = raw as Record<string, unknown>
  if (typeof v.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,500}$/.test(v.clientId) || typeof v.refreshToken !== 'string' || !v.refreshToken || v.refreshToken.length > 8192 || typeof v.userId !== 'string' || !/^\d{1,32}$/.test(v.userId) || typeof v.username !== 'string' || !/^[A-Za-z0-9_]{1,30}$/.test(v.username)) throw new Error('Invalid X connection.')
  return v as unknown as XCredentials
}
async function document(): Promise<{ version: 1; ciphertext: string } | null> {
  let raw: string; try { raw = await readFile(file(), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('X connection could not be read.') }
  let value: unknown; try { value = JSON.parse(raw) } catch { throw new Error('X connection storage is damaged; it was not changed.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).ciphertext !== 'string') throw new Error('X connection storage is invalid; it was not changed.')
  return value as { version: 1; ciphertext: string }
}
export function assertXStorageAvailable(): void { storage() }
export async function readXCredentials(): Promise<XCredentials | null> { await queue; const doc = await document(); if (!doc?.ciphertext) return null; try { return parse(JSON.parse(storage().decryptString(Buffer.from(doc.ciphertext, 'base64')))) } catch { throw new Error('X connection could not be unlocked.') } }
export function saveXCredentials(value: XCredentials): Promise<void> { return serial(async () => { const clean = parse(value); await document(); await writeJsonNow(file(), { version: 1, ciphertext: storage().encryptString(JSON.stringify(clean)).toString('base64') }) }) }
export function clearXCredentials(): Promise<void> { return serial(async () => { await document(); await writeJsonNow(file(), { version: 1, ciphertext: '' }) }) }
