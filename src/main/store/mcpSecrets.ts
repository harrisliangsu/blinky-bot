/** MCP bearer credentials encrypted with Electron safeStorage. */

import { createRequire } from 'node:module'
import type { SafeStorage } from 'electron'
import { readJsonState, writeJsonDebounced, writeJsonNow } from './jsonStore'
import { mcpSecretsFile } from './paths'

interface SecretDocument { version: 1; tokens: Record<string, string> }
const encrypted = new Map<string, string>()
let loaded = false
let writable = true
let cachedStorage: SafeStorage | null | undefined

function storage(): SafeStorage {
  if (cachedStorage === undefined) {
    try {
      const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string
      cachedStorage = typeof electron === 'object' && electron.safeStorage ? electron.safeStorage : null
    } catch { cachedStorage = null }
  }
  if (!cachedStorage?.isEncryptionAvailable()) throw new Error('The OS credential store is unavailable, so BlinkyBot refused to save a connector token in plaintext.')
  return cachedStorage
}

function persist(): void {
  if (!loaded || !writable) return
  writeJsonDebounced(mcpSecretsFile(), { version: 1, tokens: Object.fromEntries(encrypted) } satisfies SecretDocument)
}

/** A form must hear about a failed token write instead of closing optimistically. */
export async function flushMcpSecrets(): Promise<void> {
  if (!loaded || !writable) throw new Error('The connector secret store is unavailable.')
  for (;;) {
    const tokens = Object.fromEntries(encrypted)
    await writeJsonNow(mcpSecretsFile(), { version: 1, tokens } satisfies SecretDocument)
    if (JSON.stringify(tokens) === JSON.stringify(Object.fromEntries(encrypted))) return
  }
}

export async function loadMcpSecrets(): Promise<void> {
  const read = await readJsonState<SecretDocument>(mcpSecretsFile(), { version: 1, tokens: {} })
  writable = read.status !== 'unreadable'
  encrypted.clear()
  for (const [id, value] of Object.entries(read.value?.tokens ?? {})) {
    if (id && typeof value === 'string' && value) encrypted.set(id, value)
  }
  loaded = true
}

export function mcpBearerToken(id: string): string | undefined {
  const value = encrypted.get(id)
  if (!value) return undefined
  try { return storage().decryptString(Buffer.from(value, 'base64')) }
  catch (error) {
    console.error('[openbot/store] could not decrypt connector token', id, error)
    return undefined
  }
}

export const hasMcpBearerToken = (id: string): boolean => encrypted.has(id)

export function setMcpBearerToken(id: string, token: string): void {
  if (!loaded || !writable) throw new Error('The connector secret store is unavailable.')
  const clean = token.trim()
  if (!clean) return clearMcpBearerToken(id)
  encrypted.set(id, storage().encryptString(clean).toString('base64'))
  persist()
}

/** Keep the original ciphertext for a failed form save, without decrypting it. */
export function stageMcpBearerToken(id: string, token: string): () => Promise<void> {
  const previous = encrypted.get(id)
  setMcpBearerToken(id, token)
  const written = encrypted.get(id)
  return async () => {
    // A newer caller owns this credential if its ciphertext has changed.
    if (encrypted.get(id) !== written) return
    if (previous === undefined) encrypted.delete(id)
    else encrypted.set(id, previous)
    await flushMcpSecrets()
  }
}

export function clearMcpBearerToken(id: string): void {
  if (!loaded || !writable) throw new Error('The connector secret store is unavailable.')
  if (encrypted.delete(id)) persist()
}
