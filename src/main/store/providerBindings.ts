/**
 * Durable CLI thread ids.
 *
 * Claude, Kimi, Grok and Codex each remember a native conversation id in
 * process memory. That map died with the process, so the next launch either
 * started cold or — for Claude — offered an id the CLI already held. The ids
 * now live in `provider-bindings.json` under user data, next to the fingerprint
 * of what that thread has already been given, so a relaunch resumes instead of
 * replaying the transcript into a new thread.
 *
 * Clearing a chat drops every binding whose key belongs to that session. The
 * in-app transcript is a different store and is not touched here.
 */

import { readJsonState, writeJsonDebounced, writeJsonNow } from './jsonStore'
import { providerBindingsFile } from './paths'

export interface ProviderBinding {
  backendId: string
  sessionKey: string
  nativeThreadId?: string
  /** Claude rotates its derived id after a failed resume. Absent means zero. */
  restarts?: number
  /** Claude has this id, so the next turn resumes it. */
  started?: boolean
  updatedAt: number
}

interface BindingDocument {
  version: 1
  bindings: Record<string, ProviderBinding>
  delivered: Record<string, string[]>
}

const memory = new Map<string, ProviderBinding>()
const delivered = new Map<string, string[]>()
let loaded = false
let writable = true
let fileOverride: string | null = null

function emptyDocument(): BindingDocument {
  return { version: 1, bindings: {}, delivered: {} }
}

export function bindingSlot(backendId: string, sessionKey: string): string {
  return `${backendId}\0${sessionKey}`
}

function bindingsFile(): string {
  return fileOverride ?? providerBindingsFile()
}

function snapshot(): BindingDocument {
  const bindings: Record<string, ProviderBinding> = {}
  for (const [key, value] of memory) bindings[key] = value
  const sent: Record<string, string[]> = {}
  for (const [key, value] of delivered) sent[key] = value
  return { version: 1, bindings, delivered: sent }
}

function persist(): void {
  if (!writable) return
  try {
    writeJsonDebounced(bindingsFile(), snapshot())
  } catch (error) {
    console.warn('[openbot/store] provider bindings were not saved', error)
  }
}

/** Save a completed CLI binding before announcing that the turn is done. */
export async function flushProviderBindings(): Promise<void> {
  if (!writable) return
  try {
    await writeJsonNow(bindingsFile(), snapshot())
  } catch (error) {
    // A completed reply remains useful; the transcript can seed a fresh thread.
    console.warn('[openbot/store] provider bindings could not be persisted', error)
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === 'string')) return null
  return value
}

function hydrate(raw: BindingDocument | null | undefined): void {
  memory.clear()
  delivered.clear()
  const bindings = raw && typeof raw === 'object' ? raw.bindings : undefined
  if (bindings && typeof bindings === 'object') {
    for (const value of Object.values(bindings)) {
      if (!value || typeof value !== 'object') continue
      const backendId = value.backendId
      const sessionKey = value.sessionKey
      if (typeof backendId !== 'string' || !backendId || typeof sessionKey !== 'string' || !sessionKey) continue
      const binding: ProviderBinding = {
        backendId,
        sessionKey,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
      }
      if (typeof value.nativeThreadId === 'string' && value.nativeThreadId) binding.nativeThreadId = value.nativeThreadId
      if (typeof value.restarts === 'number' && value.restarts > 0) binding.restarts = value.restarts
      if (value.started === true) binding.started = true
      memory.set(bindingSlot(backendId, sessionKey), binding)
    }
  }
  const sent = raw && typeof raw === 'object' ? raw.delivered : undefined
  if (sent && typeof sent === 'object') {
    for (const [key, value] of Object.entries(sent)) {
      const marks = stringList(value)
      if (key && marks) delivered.set(key, marks)
    }
  }
}

export async function loadProviderBindings(): Promise<void> {
  if (loaded) return
  let read
  try {
    read = await readJsonState<BindingDocument>(bindingsFile(), emptyDocument())
  } catch (error) {
    loaded = true
    writable = false
    console.warn('[openbot/store] provider bindings could not be opened', error)
    return
  }
  if (read.status === 'unreadable') {
    loaded = true
    writable = false
    console.warn('[openbot/store] provider bindings were unreadable; not persisting over them')
    return
  }
  writable = true
  loaded = true
  hydrate(read.value)
}

/** Test hook. Points the store at one file and forgets whatever this process held. */
export function resetProviderBindingsForTests(file: string): void {
  fileOverride = file
  loaded = false
  writable = true
  memory.clear()
  delivered.clear()
}

export function getProviderBinding(backendId: string, sessionKey: string | undefined): ProviderBinding | undefined {
  if (!sessionKey) return undefined
  return memory.get(bindingSlot(backendId, sessionKey))
}

export function putProviderBinding(
  backendId: string,
  sessionKey: string,
  patch: { nativeThreadId?: string; restarts?: number; started?: boolean }
): void {
  if (!backendId || !sessionKey) return
  const key = bindingSlot(backendId, sessionKey)
  const prev = memory.get(key)
  const next: ProviderBinding = {
    backendId,
    sessionKey,
    updatedAt: Date.now()
  }
  const threadId = patch.nativeThreadId ?? prev?.nativeThreadId
  if (threadId) next.nativeThreadId = threadId
  const restarts = patch.restarts ?? prev?.restarts
  if (restarts && restarts > 0) next.restarts = restarts
  if ((patch.started ?? prev?.started) === true) next.started = true
  memory.set(key, next)
  persist()
}

/**
 * Drop a native thread.
 *
 * Claude keeps its restart count: the next derived id has to differ, because
 * `--session-id` refuses an id Claude has already seen. Every other CLI mints
 * the next id itself, so the record can go. The delivery watermark goes with
 * the thread — a fresh thread has not seen the transcript.
 */
export function forgetProviderBinding(backendId: string, sessionKey: string | undefined): void {
  if (!backendId || !sessionKey) return
  const key = bindingSlot(backendId, sessionKey)
  const prev = memory.get(key)
  delivered.delete(sessionKey)
  if (backendId === 'claude') {
    const restarts = (prev?.restarts ?? 0) + 1
    memory.set(key, { backendId, sessionKey, restarts, updatedAt: Date.now() })
  } else {
    memory.delete(key)
  }
  persist()
}

/** True when this CLI key was built for `sessionId` (`conversationKey` puts it second). */
export function sessionKeyMatches(sessionKey: string, sessionId: string): boolean {
  if (!sessionId || !sessionKey) return false
  if (sessionKey === sessionId) return true
  try {
    const parsed = JSON.parse(sessionKey) as unknown
    return Array.isArray(parsed) && parsed[1] === sessionId
  } catch {
    return false
  }
}

/** Drop every native thread that belongs to this in-app conversation. */
export function forgetBindingsForSession(sessionId: string): void {
  if (!sessionId) return
  const matched = [...memory.values()].filter((binding) => sessionKeyMatches(binding.sessionKey, sessionId))
  for (const binding of matched) forgetProviderBinding(binding.backendId, binding.sessionKey)
  for (const sessionKey of [...delivered.keys()]) {
    if (sessionKeyMatches(sessionKey, sessionId)) delivered.delete(sessionKey)
  }
  persist()
}

/** Internal one-use native threads must never be resumed or leave restart tombstones. */
export function discardEphemeralBindingsForSession(sessionId:string):void {
  for(const [key,binding] of memory)if(sessionKeyMatches(binding.sessionKey,sessionId))memory.delete(key)
  for(const key of delivered.keys())if(sessionKeyMatches(key,sessionId))delivered.delete(key)
  persist()
}

export function deliveredFingerprints(sessionKey: string | undefined): string[] {
  if (!sessionKey) return []
  return delivered.get(sessionKey) ?? []
}

export function setDeliveredFingerprints(sessionKey: string | undefined, marks: string[]): void {
  if (!sessionKey) return
  delivered.set(sessionKey, marks)
  persist()
}

export function clearDeliveredFingerprints(sessionKey: string | undefined): void {
  if (!sessionKey || !delivered.has(sessionKey)) return
  delivered.delete(sessionKey)
  persist()
}
