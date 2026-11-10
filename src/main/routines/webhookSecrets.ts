/** The webhook credential is generated only on an explicit user request. */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { dataRoot, ensureDir } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'

let override: SafeStorage | null | undefined
export function setWebhookStorageForTests(value: SafeStorage | null | undefined): void { override = value }
function storage(): SafeStorage {
  let api = override
  if (api === undefined) { try { const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string; api = typeof electron === 'object' ? electron.safeStorage ?? null : null } catch { api = null } }
  if (!api?.isEncryptionAvailable()) throw new Error('System encryption is unavailable.')
  return api
}
function pathFor(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid routine id.')
  return join(ensureDir(join(dataRoot(), 'webhook-secrets')), `${id}.json`)
}
export async function readWebhookSecret(id: string): Promise<string | null> {
  let raw: string
  try { raw = await readFile(pathFor(id), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Webhook credential cannot be read.') }
  try {
    const doc = JSON.parse(raw) as { version?: unknown; ciphertext?: unknown }
    if (doc.version !== 1 || typeof doc.ciphertext !== 'string') throw new Error('invalid')
    const secret = storage().decryptString(Buffer.from(doc.ciphertext, 'base64'))
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('invalid')
    return secret
  } catch { throw new Error('Webhook credential cannot be unlocked; it was not changed.') }
}
const creating = new Map<string, Promise<string>>()
export function getOrCreateWebhookSecret(id: string): Promise<string> {
  const pending = creating.get(id); if (pending) return pending
  const work = (async () => {
    const current = await readWebhookSecret(id); if (current) return current
    const secret = randomBytes(32).toString('base64url')
    await writeJsonNow(pathFor(id), { version: 1, ciphertext: storage().encryptString(secret).toString('base64') })
    return secret
  })().finally(() => creating.delete(id))
  creating.set(id, work); return work
}
