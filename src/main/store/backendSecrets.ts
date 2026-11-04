/** Model-backend credentials encrypted with Electron safeStorage. */

import { createRequire } from 'node:module'
import type { SafeStorage } from 'electron'
import { readJsonState, writeJsonDebounced } from './jsonStore'
import { backendSecretsFile } from './paths'

interface SecretDocument {
  version: 1
  keys: Record<string, string>
}

const encrypted = new Map<string, string>()
let loaded = false
let writable = true
let cachedStorage: SafeStorage | null | undefined

/** Test seam for the OS-owned encryption primitive. */
export function setBackendSafeStorageForTests(storage: SafeStorage | null | undefined): void {
  cachedStorage = storage
}

function safeStorageApi(): SafeStorage | null {
  if (cachedStorage !== undefined) return cachedStorage
  try {
    const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorage } | string
    cachedStorage = typeof electron === 'object' && electron.safeStorage ? electron.safeStorage : null
  } catch {
    cachedStorage = null
  }
  return cachedStorage
}

function requireStorage(): SafeStorage {
  const storage = safeStorageApi()
  if (!storage?.isEncryptionAvailable()) {
    throw new Error('The OS credential store is unavailable, so BlinkyBot refused to save an API key in plaintext.')
  }
  return storage
}

function persist(): void {
  if (!loaded || !writable) return
  writeJsonDebounced(backendSecretsFile(), {
    version: 1,
    keys: Object.fromEntries(encrypted)
  } satisfies SecretDocument)
}

export async function loadBackendSecrets(): Promise<void> {
  const read = await readJsonState<SecretDocument>(backendSecretsFile(), { version: 1, keys: {} })
  writable = read.status !== 'unreadable'
  encrypted.clear()
  if (read.value && typeof read.value.keys === 'object' && read.value.keys !== null) {
    for (const [id, value] of Object.entries(read.value.keys)) {
      if (id && typeof value === 'string' && value) encrypted.set(id, value)
    }
  }
  loaded = true
}

export function backendApiKey(backendId: string): string | undefined {
  const value = encrypted.get(backendId)
  if (!value) return undefined
  try {
    return requireStorage().decryptString(Buffer.from(value, 'base64'))
  } catch (error) {
    console.error('[openbot/store] could not decrypt API key for backend', backendId, error)
    return undefined
  }
}

export function hasBackendApiKey(backendId: string): boolean {
  return encrypted.has(backendId)
}

export function setBackendApiKey(backendId: string, apiKey: string): void {
  if (!loaded) throw new Error('Backend secret storage has not been loaded yet.')
  if (!writable) throw new Error('The backend secret store could not be read, so BlinkyBot refused to overwrite it.')
  const clean = apiKey.trim()
  if (!clean) {
    clearBackendApiKey(backendId)
    return
  }
  encrypted.set(backendId, requireStorage().encryptString(clean).toString('base64'))
  persist()
}

export function clearBackendApiKey(backendId: string): void {
  if (!loaded) throw new Error('Backend secret storage has not been loaded yet.')
  if (!writable) throw new Error('The backend secret store could not be read, so BlinkyBot refused to overwrite it.')
  if (!encrypted.delete(backendId)) return
  persist()
}
