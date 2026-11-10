/** Local vault: values are encrypted by the OS before durable storage. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import type { VaultInput, VaultItem, VaultKind, VaultUpdate } from '../../shared/vault'
import { writeJsonNow } from './jsonStore'
import { dataRoot } from './paths'

interface VaultRecord { metadata: VaultItem; ciphertext: string }
interface VaultDocument { version: 1; items: VaultRecord[] }
const FIELDS: Record<VaultKind, readonly string[]> = {
  login: ['username', 'password'],
  card: ['holder', 'number', 'expiry', 'security_code'],
  address: ['recipient', 'street', 'city', 'region', 'postal_code', 'country']
}
let storageOverride: SafeStorage | null | undefined
let cached: VaultDocument | undefined
let chain: Promise<unknown> = Promise.resolve()

/** Test seam; production obtains Electron's OS-owned encryption service. */
export function setVaultStorageForTests(storage: SafeStorage | null | undefined): void { storageOverride = storage; cached = undefined }

function storage(): SafeStorage {
  let api = storageOverride
  if (api === undefined) {
    try { const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string; api = typeof electron === 'object' ? electron.safeStorage ?? null : null }
    catch { api = null }
  }
  if (!api?.isEncryptionAvailable() || api.getSelectedStorageBackend?.() === 'basic_text') throw new Error('System encryption is unavailable; the vault cannot store values securely.')
  return api
}

function file(): string { return join(dataRoot(), 'vault.json') }

async function load(): Promise<VaultDocument> {
  if (cached) return cached
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = { version: 1, items: [] })
    throw new Error('The vault could not be read; it was not changed.')
  }
  return (cached = parseVaultDocument(raw))
}

function parseVaultDocument(raw: string): VaultDocument {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('The vault file is damaged; it was not changed.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The vault file is invalid; it was not changed.')
  const doc = value as Partial<VaultDocument>
  if (doc.version !== 1 || !Array.isArray(doc.items) || !doc.items.every((item) => {
    const m = item?.metadata
    return Boolean(m && typeof m.id === 'string' && typeof m.label === 'string' && Object.hasOwn(FIELDS, m.kind) && Array.isArray(m.fields) && m.fields.every((field) => typeof field === 'string' && FIELDS[m.kind].includes(field)) && typeof m.createdAt === 'number' && typeof item.ciphertext === 'string' && item.ciphertext.length > 0)
  })) throw new Error('The vault file is invalid; it was not changed.')
  return doc as VaultDocument
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work)
  chain = result.catch(() => undefined)
  return result
}

function cleanOrigin(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new Error('Use a valid HTTPS site origin.') }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS site origin without credentials.')
  return url.origin
}

export async function listVaultItems(): Promise<VaultItem[]> {
  await chain
  const doc = await load()
  return doc.items.map(({ metadata }) => ({ id: metadata.id, kind: metadata.kind, label: metadata.label, ...(typeof metadata.origin === 'string' ? { origin: metadata.origin } : {}), fields: [...metadata.fields], createdAt: metadata.createdAt }))
}

export async function addVaultItem(input: VaultInput): Promise<VaultItem> {
  return serial(async () => {
    if (!input || !Object.hasOwn(FIELDS, input.kind)) throw new Error('Unknown vault item type.')
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 120) : ''
    if (!label) throw new Error('A name is required.')
    const origin = cleanOrigin(input.origin)
    if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw new Error('Vault fields are invalid.')
    const values: Record<string, string> = {}
    for (const key of FIELDS[input.kind]) {
      const value = input.values[key]
      if (typeof value === 'string' && value.trim()) values[key] = value.slice(0, 4096)
    }
    const fields = Object.keys(values)
    if (!fields.length) throw new Error('At least one field is required.')
    const doc = await load()
    if (doc.items.length >= 500) throw new Error('The vault is full.')
    const metadata: VaultItem = { id: randomUUID(), kind: input.kind, label, ...(origin ? { origin } : {}), fields, createdAt: Date.now() }
    const ciphertext = storage().encryptString(JSON.stringify(values)).toString('base64')
    const next: VaultDocument = { version: 1, items: [...doc.items, { metadata, ciphertext }] }
    await writeJsonNow(file(), next)
    cached = next
    return { ...metadata, fields: [...fields] }
  })
}

/** Edit metadata or replace selected fields without exposing any saved value. */
export function updateVaultItem(id: string, input: VaultUpdate): Promise<VaultItem> {
  return serial(async () => {
    if (!input || typeof input.label !== 'string' || !input.label.trim()) throw new Error('A name is required.')
    const doc = await load(), at = doc.items.findIndex(item => item.metadata.id === id)
    if (at < 0) throw new Error('The vault item no longer exists.')
    const previous = doc.items[at], origin = Object.hasOwn(input, 'origin') ? cleanOrigin(input.origin) : doc.items[at].metadata.origin
    const metadata: VaultItem = { ...previous.metadata, label: input.label.trim().slice(0, 120), fields: [...previous.metadata.fields] }
    if (origin) metadata.origin = origin; else delete metadata.origin
    let ciphertext = previous.ciphertext
    const replacements = Object.fromEntries(FIELDS[metadata.kind].flatMap(key => typeof input.values?.[key] === 'string' && input.values[key].trim() ? [[key, input.values[key].slice(0, 4096)]] : []))
    if (Object.keys(replacements).length) {
      const api = storage(), raw: unknown = JSON.parse(api.decryptString(Buffer.from(ciphertext, 'base64')))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The saved vault fields are invalid; they were not changed.')
      const values = raw as Record<string, string>
      Object.assign(values, replacements); metadata.fields = FIELDS[metadata.kind].filter(key => typeof values[key] === 'string' && values[key].trim())
      ciphertext = api.encryptString(JSON.stringify(values)).toString('base64')
    }
    const items = [...doc.items]; items[at] = { metadata, ciphertext }
    const next: VaultDocument = { version: 1, items }
    await writeJsonNow(file(), next); cached = next
    return { ...metadata, fields: [...metadata.fields] }
  })
}

export async function removeVaultItem(id: string): Promise<boolean> {
  return serial(async () => {
    const doc = await load()
    if (!doc.items.some((item) => item.metadata.id === id)) return false
    const next: VaultDocument = { version: 1, items: doc.items.filter((item) => item.metadata.id !== id) }
    await writeJsonNow(file(), next)
    cached = next
    return true
  })
}

/** Runs only in the main process. The callback must never return the decrypted value. */
export async function useVaultField(id: string, field: string, fill: (origin: string, value: string) => Promise<boolean>): Promise<boolean> {
  return serial(async () => {
    id = vaultItemId(id)
    const item = (await load()).items.find((record) => record.metadata.id === id)
    if (!item || !item.metadata.origin || !item.metadata.fields.includes(field) || !FIELDS[item.metadata.kind].includes(field)) throw new Error('The vault item or its site is unavailable.')
    if (cleanOrigin(item.metadata.origin) !== item.metadata.origin) throw new Error('The vault site is invalid.')
    let parsed: unknown
    try { parsed = JSON.parse(storage().decryptString(Buffer.from(item.ciphertext, 'base64'))) } catch { throw new Error('The vault item could not be unlocked.') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The vault item is invalid.')
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('The vault field is unavailable.')
    // A faulty adapter must not turn its result or exception into a secret
    // retrieval interface, even if it violates the TypeScript callback type.
    try { return (await fill(item.metadata.origin, value)) === true }
    catch { throw new Error('The vault field could not be used.') }
  })
}

/** Opaque references are safe to pass between components; legacy ids still work. */
export function vaultItemRef(id: string): string { return `vault://ref/${vaultItemId(id)}` }
export function vaultItemId(reference: string): string {
  const id = typeof reference === 'string' ? reference.replace(/^vault:\/\/ref\//, '') : ''
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid vault reference.')
  return id
}

/** Main-process integration hook for log/memory owners. Never returns values.
 * Exact literals only: transformed, encoded and OCR-derived values need their
 * own output boundary. Fail closed if the vault cannot be read or unlocked.
 */
export async function scrubVaultText(text: string): Promise<{ text: string; redacted: boolean; unavailable: boolean }> {
  return serial(async () => scrubVaultTextNow(text))
}

/** Synchronous output boundaries must not wait on the fill callback's own lock.
 * Read a fresh atomic document each time, including writes by another process;
 * do not retain decrypted values or silently use an older cached snapshot.
 */
export function scrubVaultTextNow(text: string): { text: string; redacted: boolean; unavailable: boolean } {
  const checked = scrubVaultTextsNow([text])
  return { text: checked.texts[0], redacted: checked.redacted, unavailable: checked.unavailable }
}

/** One encrypted snapshot per record; decrypted literals live only for this call. */
export function scrubVaultTextsNow(texts: string[]): { texts: string[]; redacted: boolean; unavailable: boolean } {
    try {
      let raw: string
      try { raw = readFileSync(file(), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { texts, redacted: false, unavailable: false }
        throw error
      }
      const doc = parseVaultDocument(raw)
      if (!doc.items.length) return { texts, redacted: false, unavailable: false }
      const api = storage(), values = new Set<string>()
      for (const item of doc.items) {
        const decoded = JSON.parse(api.decryptString(Buffer.from(item.ciphertext, 'base64')))
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid')
        for (const field of FIELDS[item.metadata.kind]) {
          const value = decoded[field]
          if (typeof value === 'string' && value) values.add(value)
        }
      }
      const ordered = [...values].sort((a, b) => b.length - a.length)
      const safe = texts.map(text => {
        let next = text
        for (const value of ordered) next = next.split(value).join('[vault value]')
        return next
      })
      return { texts: safe, redacted: safe.some((value, i) => value !== texts[i]), unavailable: false }
    } catch { return { texts: texts.map(() => '[Content withheld: vault unavailable]'), redacted: true, unavailable: true } }
}

/** A stream keeps only an undecided literal prefix. No decrypted dictionary leaves
 * this module. A changed/unreadable vault closes this stream until it is discarded.
 * Context follows the original bytes, including a match spanning public segments.
 */
export function createVaultTextStream<T>(): {
  push(text: string, context: T): Array<{ text: string; context: T }>
  finish(): Array<{ text: string; context: T }>
} {
  const snapshot = (): { revision: string; values: string[] } => {
    let raw: string
    try { raw = readFileSync(file(), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 'absent', values: [] }
      throw error
    }
    const doc = parseVaultDocument(raw), values = new Set<string>()
    if (doc.items.length) {
      const api = storage()
      for (const item of doc.items) {
        const decoded = JSON.parse(api.decryptString(Buffer.from(item.ciphertext, 'base64')))
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid')
        for (const field of FIELDS[item.metadata.kind]) {
          const value = decoded[field]
          if (typeof value === 'string' && value) values.add(value)
        }
      }
    }
    return { revision: createHash('sha256').update(raw).digest('hex'), values: [...values].sort((a, b) => b.length - a.length) }
  }
  let revision: string | undefined, closed = false, ended = false, pending = ''
  const pieces: Array<{ text: string; context: T }> = []
  try { revision = snapshot().revision } catch { /* first push emits the fixed failure marker */ }
  const drain = (final: boolean): Array<{ text: string; context: T }> => {
    if (!pending) return []
    const output: Array<{ text: string; context: T }> = []
    const emit = (length: number, text: string): void => {
      const context = pieces[0].context
      let remaining = length
      while (remaining) {
        const first = pieces[0], consumed = Math.min(remaining, first.text.length)
        first.text = first.text.slice(consumed); remaining -= consumed
        if (!first.text) pieces.shift()
      }
      pending = pending.slice(length)
      const last = output.at(-1)
      if (last && last.context === context) last.text += text
      else output.push({ text, context })
    }
    let checked: ReturnType<typeof snapshot>
    try {
      checked = snapshot()
      if (revision === undefined || checked.revision !== revision) throw new Error('changed')
    } catch {
      const context = pieces[0].context
      pending = ''; pieces.length = 0; closed = true
      return [{ text: '[Content withheld: vault unavailable or changed]', context }]
    }
    const initials = new Set(checked.values.map(value => value[0]))
    while (pending) {
      if (!initials.has(pending[0])) {
        let length = 1
        while (length < pieces[0].text.length && !initials.has(pending[length])) length++
        emit(length, pending.slice(0, length))
        continue
      }
      // Hold even a complete short match if a longer literal could still follow.
      const prefix = checked.values.some(value => value.startsWith(pending))
      if (prefix && !final) break
      if (prefix) { emit(pending.length, '[vault value]'); continue }
      const match = checked.values.find(value => pending.startsWith(value))
      if (match) emit(match.length, '[vault value]')
      else emit(1, pending[0])
    }
    return output
  }
  return {
    push(text, context) {
      if (closed || ended || !text) return []
      pending += text; pieces.push({ text, context })
      return drain(false)
    },
    finish() {
      if (closed || ended) return []
      ended = true
      return drain(true)
    }
  }
}

/** Reject private memory instead of saving a placeholder as a false fact. */
export function requireVaultSafeMemory(...texts: string[]): void {
  const checked = scrubVaultTextNow([...new Set(texts)].join('\n'))
  if (checked.redacted || checked.unavailable) throw new Error('记忆包含保险库信息或暂时无法安全检查，未保存。')
}
