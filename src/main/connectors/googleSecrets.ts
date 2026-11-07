/** Google refresh credentials stay encrypted at rest and never enter renderer or model APIs. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { dataRoot } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'

export type GoogleService = 'gmail' | 'calendar'
export interface GoogleCredentials {
  clientId: string
  clientSecret?: string
  refreshToken: string
  scopes: string[]
  account: string
}
interface EncryptedDocument { version: 1 | 2; values: Partial<Record<GoogleService, string>>; accounts?: Partial<Record<GoogleService, Record<string, string>>> }
export interface GoogleAccountInfo { id: string; label: string; isDefault: boolean }
let override: SafeStorage | null | undefined
let queue: Promise<unknown> = Promise.resolve()

export function setGoogleStorageForTests(storage: SafeStorage | null | undefined): void { override = storage }
function storage(): SafeStorage {
  let api = override
  if (api === undefined) {
    try { const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string; api = typeof electron === 'object' ? electron.safeStorage ?? null : null } catch { api = null }
  }
  if (!api?.isEncryptionAvailable()) throw new Error('System encryption is unavailable.')
  return api
}
export function assertGoogleSecretStorageAvailable(): void { storage() }
function file(): string { return join(dataRoot(), 'google-connections.json') }
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }

async function document(): Promise<EncryptedDocument> {
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, values: {} }
    throw new Error('The Google connection store could not be read; it was not changed.')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('The Google connection store is damaged; it was not changed.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The Google connection store is invalid; it was not changed.')
  const doc = parsed as Record<string, unknown>, values = doc.values
  if ((doc.version !== 1 && doc.version !== 2) || !values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) => !['gmail','calendar'].includes(key) || typeof value !== 'string' || !value)) throw new Error('The Google connection store is invalid; it was not changed.')
  if (doc.version === 1 && doc.accounts !== undefined) throw new Error('The Google connection store is invalid; it was not changed.')
  if (doc.version === 2) {
    const accounts = doc.accounts
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || Object.entries(accounts).some(([service, entries]) => !['gmail','calendar'].includes(service) || !entries || typeof entries !== 'object' || Array.isArray(entries) || Object.entries(entries).some(([id, encrypted]) => !/^g_[a-f0-9]{24}$/.test(id) || typeof encrypted !== 'string' || !encrypted))) throw new Error('The Google account namespace is invalid; it was not changed.')
  }
  return parsed as EncryptedDocument
}

function credentials(raw: unknown): GoogleCredentials {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The Google connection cannot be decrypted.')
  const value = raw as Record<string, unknown>
  if (typeof value.clientId !== 'string' || typeof value.refreshToken !== 'string' || !value.refreshToken || typeof value.account !== 'string' || !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === 'string') || (value.clientSecret !== undefined && typeof value.clientSecret !== 'string')) throw new Error('The Google connection is invalid.')
  return value as unknown as GoogleCredentials
}

/** Stable opaque identity; the service still owns a separate authorization grant. */
export function googleAccountId(account: string): string {
  if (!account.trim()) throw new Error('The Google account identity is invalid.')
  return 'g_' + createHash('sha256').update(account.trim().toLowerCase()).digest('hex').slice(0, 24)
}
function unlock(encrypted: string | undefined): GoogleCredentials | null {
  if (!encrypted) return null
  try { return credentials(JSON.parse(storage().decryptString(Buffer.from(encrypted, 'base64')))) } catch { throw new Error('The Google connection could not be unlocked.') }
}
function checkedId(id: string): void { if (!/^g_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid Google account identifier.') }
function named(doc: EncryptedDocument, service: GoogleService, id: string): GoogleCredentials | null {
  checkedId(id)
  const original = unlock(doc.values[service])
  if (original && googleAccountId(original.account) === id) return original
  const value = unlock(doc.accounts?.[service]?.[id])
  if (value && googleAccountId(value.account) !== id) throw new Error('The Google account namespace does not match its grant.')
  return value
}
function namespaces(doc: EncryptedDocument): NonNullable<EncryptedDocument['accounts']> { return Object.fromEntries(Object.entries(doc.accounts ?? {}).map(([service, entries]) => [service, { ...entries }])) }
export async function readGoogleCredentials(service: GoogleService, accountId?: string): Promise<GoogleCredentials | null> {
  await queue
  const doc = await document()
  return accountId === undefined ? unlock(doc.values[service]) : named(doc, service, accountId)
}

export async function listGoogleAccounts(service: GoogleService): Promise<GoogleAccountInfo[]> {
  await queue
  const doc = await document(), original = unlock(doc.values[service]), result: GoogleAccountInfo[] = []
  if (original) result.push({ id: googleAccountId(original.account), label: original.account, isDefault: true })
  for (const [id, encrypted] of Object.entries(doc.accounts?.[service] ?? {})) {
    const value = unlock(encrypted)!
    if (googleAccountId(value.account) !== id || result.some(item => item.id === id)) throw new Error('The Google account namespace is ambiguous.')
    result.push({ id, label: value.account, isDefault: false })
  }
  return result
}

export function saveGoogleCredentials(service: GoogleService, input: GoogleCredentials, accountId?: string): Promise<void> {
  return serial(async () => {
    const value = credentials(input), doc = await document(), accounts = namespaces(doc)
    const encrypted = storage().encryptString(JSON.stringify(value)).toString('base64')
    const id = googleAccountId(value.account)
    if (accountId !== undefined && (accountId !== id || !named(doc, service, accountId))) throw new Error('The selected Google account is no longer connected.')
    const original = unlock(doc.values[service])
    if (accountId === undefined || (original && googleAccountId(original.account) === accountId)) {
      if (accounts[service]) delete accounts[service]![id]
      await writeJsonNow(file(), { ...doc, values: { ...doc.values, [service]: encrypted }, ...(doc.version === 2 ? { accounts } : {}) })
    } else {
      accounts[service]![id] = encrypted
      await writeJsonNow(file(), { ...doc, accounts })
    }
  })
}

/** Only the explicit Add account flow introduces the v2 namespace. Reads never migrate. */
export function addGoogleCredentials(service: GoogleService, input: GoogleCredentials): Promise<string> {
  return serial(async () => {
    const value = credentials(input), doc = await document(), accounts = namespaces(doc), id = googleAccountId(value.account)
    const encrypted = storage().encryptString(JSON.stringify(value)).toString('base64'), original = unlock(doc.values[service])
    const values = { ...doc.values }
    if (original && googleAccountId(original.account) === id) values[service] = encrypted
    else accounts[service] = { ...accounts[service], [id]: encrypted }
    await writeJsonNow(file(), { version: 2, values, accounts } satisfies EncryptedDocument)
    return id
  })
}

/** Removes local credentials only; remote Google consent is not revoked here. */
export function removeGoogleCredentials(service: GoogleService, accountId?: string): Promise<void> {
  return serial(async () => {
    const doc = await document(), values = { ...doc.values }, accounts = namespaces(doc)
    if (accountId === undefined) { if (!values[service]) return; delete values[service] }
    else {
      checkedId(accountId)
      const original = unlock(values[service])
      if (original && googleAccountId(original.account) === accountId) delete values[service]
      else { if (!accounts[service]?.[accountId]) return; delete accounts[service]![accountId] }
    }
    await writeJsonNow(file(), { ...doc, values, ...(doc.version === 2 ? { accounts } : {}) })
  })
}
