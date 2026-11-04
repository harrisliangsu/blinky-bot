/** VM control credentials encrypted with Electron safeStorage (Keychain on macOS). */

import { createRequire } from 'node:module'
import type { SafeStorage } from 'electron'
import { readJsonState, writeJsonDebounced } from './jsonStore'
import { vmSecretsFile } from './paths'

interface SecretDocument {
  version: 1
  tokens: Record<string, string>
}

const encrypted = new Map<string, string>()
let loaded = false
let writable = true
let cachedStorage: SafeStorage | null | undefined

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
    throw new Error('The OS credential store is unavailable, so BlinkyBot refused to save the VM token in plaintext.')
  }
  return storage
}

function persist(): void {
  if (!loaded || !writable) return
  writeJsonDebounced(vmSecretsFile(), {
    version: 1,
    tokens: Object.fromEntries(encrypted)
  } satisfies SecretDocument)
}

export async function loadVmSecrets(): Promise<void> {
  const read = await readJsonState<SecretDocument>(vmSecretsFile(), { version: 1, tokens: {} })
  writable = read.status !== 'unreadable'
  encrypted.clear()
  if (read.value && typeof read.value.tokens === 'object' && read.value.tokens !== null) {
    for (const [id, value] of Object.entries(read.value.tokens)) {
      if (id && typeof value === 'string' && value) encrypted.set(id, value)
    }
  }
  loaded = true
}

export function vmToken(botId: string): string | undefined {
  const value = encrypted.get(botId)
  if (!value) return undefined
  try {
    return requireStorage().decryptString(Buffer.from(value, 'base64'))
  } catch (err) {
    console.error('[openbot/store] could not decrypt VM token for bot', botId, err)
    return undefined
  }
}

export function hasVmToken(botId: string): boolean {
  return encrypted.has(botId)
}

export function setVmToken(botId: string, token: string): void {
  if (!loaded) throw new Error('VM secret storage has not been loaded yet.')
  if (!writable) throw new Error('The VM secret store could not be read, so BlinkyBot refused to overwrite it.')
  const clean = token.trim()
  if (!clean) {
    clearVmToken(botId)
    return
  }
  encrypted.set(botId, requireStorage().encryptString(clean).toString('base64'))
  persist()
}

export function clearVmToken(botId: string): void {
  if (!encrypted.delete(botId)) return
  persist()
}
