import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { Attachment } from '../../../shared/types'

interface Draft { text: string; attachments: Attachment[]; quote: Attachment | null }
const empty: Draft = { text: '', attachments: [], quote: null }
const drafts = new Map<string, Draft>()
const listeners = new Map<string, Set<() => void>>()

let browserStorageKey: string | null = null
/** Restore only after this device has been approved for this invitation and scope. */
export function bindBrowserDrafts(key: string): void {
  browserStorageKey = key
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}')
    for (const [id, value] of Object.entries(saved)) {
      const draft = value as Draft
      if (draft && typeof draft.text === 'string' && Array.isArray(draft.attachments)) drafts.set(id, { text: draft.text, attachments: draft.attachments, quote: draft.quote ?? null })
    }
  } catch { /* Storage unavailable or quota exceeded: same-page drafts still work. */ }
}
export function clearBrowserDrafts(): void {
  if (browserStorageKey) { try { sessionStorage.removeItem(browserStorageKey) } catch {} }
  drafts.clear(); browserStorageKey = null
}
function persistBrowserDrafts(): void {
  if (!browserStorageKey) return
  try {
    // The host already owns uploaded bytes. Persist their device-bound reference,
    // not multi-megabyte preview data; a reload can still send the attachment.
    const saved = Object.fromEntries([...drafts].map(([id, draft]) => [id, { ...draft, attachments: draft.attachments.map(attachment => {
      if (attachment.kind === 'image' && attachment.path?.startsWith('blinky-upload:')) { const { data: _preview, ...reference } = attachment; return reference }
      return attachment
    }) }]))
    sessionStorage.setItem(browserStorageKey, JSON.stringify(saved))
    window.dispatchEvent(new CustomEvent('blinky:remote-draft-storage', { detail: true }))
  } catch {
    // An old snapshot must not resurrect an already sent draft on reload.
    try { sessionStorage.removeItem(browserStorageKey) } catch { /* storage is unavailable */ }
    // Preserve the in-memory draft and make an unsafe refresh visible.
    window.dispatchEvent(new CustomEvent('blinky:remote-draft-storage', { detail: false }))
  }
}

/** Keep each Bot's unsent draft with its conversation during this app run. */
export function useComposerDraft(sessionId: string | undefined): {
  text: string
  attachments: Attachment[]
  quote: Attachment | null
  setText: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setQuote: Dispatch<SetStateAction<Attachment | null>>
} {
  const key = sessionId ?? ''
  const subscribe = useCallback((notify: () => void) => {
    const entries = listeners.get(key) ?? new Set<() => void>()
    entries.add(notify)
    listeners.set(key, entries)
    return () => { entries.delete(notify); if (!entries.size) listeners.delete(key) }
  }, [key])
  const snapshot = useCallback(() => drafts.get(key) ?? empty, [key])
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot)
  const setText = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    const current = drafts.get(key) ?? empty
    const text = typeof update === 'function' ? update(current.text) : update
    save(key, { ...current, text })
  }, [key])
  const setAttachments = useCallback<Dispatch<SetStateAction<Attachment[]>>>((update) => {
    const current = drafts.get(key) ?? empty
    const attachments = typeof update === 'function' ? update(current.attachments) : update
    save(key, { ...current, attachments })
  }, [key])
  const setQuote = useCallback<Dispatch<SetStateAction<Attachment | null>>>((update) => {
    const current = drafts.get(key) ?? empty
    const quote = typeof update === 'function' ? update(current.quote) : update
    save(key, { ...current, quote })
  }, [key])
  return { ...draft, setText, setAttachments, setQuote }
}

export function setComposerQuote(sessionId: string, quote: Attachment): void {
  save(sessionId, { ...(drafts.get(sessionId) ?? empty), quote })
}

function save(key: string, draft: Draft): void {
  if (!draft.text && !draft.attachments.length && !draft.quote) drafts.delete(key)
  else drafts.set(key, draft)
  persistBrowserDrafts()
  for (const notify of listeners.get(key) ?? []) notify()
}
