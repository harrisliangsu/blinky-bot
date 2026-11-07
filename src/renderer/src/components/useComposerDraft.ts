import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { Attachment } from '../../../shared/types'

interface Draft { text: string; attachments: Attachment[]; quote: Attachment | null }
const empty: Draft = { text: '', attachments: [], quote: null }
const drafts = new Map<string, Draft>()
const listeners = new Map<string, Set<() => void>>()

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
  for (const notify of listeners.get(key) ?? []) notify()
}
