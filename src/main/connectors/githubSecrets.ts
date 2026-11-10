/** User-authorized GitHub credentials are encrypted by the OS and stay in the main process. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { dataRoot } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'
import { validateGitHubClient } from './oauthClients'

export interface GitHubCredentials { clientId: string; clientSecret: string; refreshToken: string; login: string }
let override: SafeStorage | null | undefined
let queue: Promise<unknown> = Promise.resolve()
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
export function setGitHubStorageForTests(value: SafeStorage | null | undefined): void { override = value }
function storage(): SafeStorage {
  let api = override
  if (api === undefined) { try { const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string; api = typeof electron === 'object' ? electron.safeStorage ?? null : null } catch { api = null } }
  if (!api?.isEncryptionAvailable()) throw new Error('System encryption is unavailable.')
  return api
}
function file(): string { return join(dataRoot(), 'github-oauth.json') }
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }
function parse(raw: unknown): GitHubCredentials {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid GitHub connection.')
  const value = raw as Record<string, unknown>
  if (typeof value.clientId !== 'string' || typeof value.clientSecret !== 'string' || typeof value.refreshToken !== 'string' || !value.refreshToken || value.refreshToken.length > 8192 || typeof value.login !== 'string' || !LOGIN.test(value.login)) throw new Error('Invalid GitHub connection.')
  validateGitHubClient(value.clientId, value.clientSecret)
  return { clientId: value.clientId, clientSecret: value.clientSecret, refreshToken: value.refreshToken, login: value.login }
}
async function document(): Promise<{ version: 1; ciphertext: string } | null> {
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('GitHub connection could not be read.') }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('GitHub connection storage is damaged; it was not changed.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).ciphertext !== 'string') throw new Error('GitHub connection storage is invalid; it was not changed.')
  return value as { version: 1; ciphertext: string }
}
export function assertGitHubStorageAvailable(): void { storage() }
export async function readGitHubCredentials(): Promise<GitHubCredentials | null> {
  await queue
  const doc = await document()
  if (!doc?.ciphertext) return null
  try { return parse(JSON.parse(storage().decryptString(Buffer.from(doc.ciphertext, 'base64')))) } catch { throw new Error('GitHub connection could not be unlocked.') }
}
export function saveGitHubCredentials(value: GitHubCredentials): Promise<void> {
  return serial(async () => { const clean = parse(value); await document(); await writeJsonNow(file(), { version: 1, ciphertext: storage().encryptString(JSON.stringify(clean)).toString('base64') }) })
}
export function clearGitHubCredentials(): Promise<void> {
  return serial(async () => { await document(); await writeJsonNow(file(), { version: 1, ciphertext: '' }) })
}

/**
 * Version 1 of github-connection.json was only an opt-out flag for the shared
 * `gh` CLI. It is not an OAuth grant. A missing file used to mean "use gh",
 * which also no longer counts as connected.
 */
export async function legacyGitHubCliOptIn(): Promise<boolean> {
  let raw: string
  try { raw = await readFile(join(dataRoot(), 'github-connection.json'), 'utf8') } catch { return false }
  try {
    const value = JSON.parse(raw) as { version?: unknown; enabled?: unknown }
    return !!value && value.version === 1 && value.enabled === true
  } catch { return false }
}
