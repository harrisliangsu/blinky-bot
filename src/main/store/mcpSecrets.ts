/** MCP bearer credentials encrypted with Electron safeStorage. */

import { createRequire } from 'node:module'
import type { SafeStorage } from 'electron'
import { readJsonState, writeJsonDebounced } from './jsonStore'
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

export function clearMcpBearerToken(id: string): void {
  if (!loaded || !writable) throw new Error('The connector secret store is unavailable.')
  if (encrypted.delete(id)) persist()
}
