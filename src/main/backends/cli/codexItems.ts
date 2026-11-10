/**
 * What the notification stream said, kept for the approval request that needs
 * it — plus the readers that pull those values out of the raw payloads.
 *
 * The readers live here rather than in a helpers module of their own because
 * they exist to parse exactly the notification payloads this index stores:
 * `codexEvents.ts` and `codexApprovals.ts` read the same fields off the same
 * messages, so one definition serves all three.
 */

import { isPlainObject } from '../lenientJson'

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An argv array as one line. Empty unless every element is a string. */
export function joinCommand(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value.every((part) => typeof part === 'string') ? value.join(' ') : ''
}

/* ── what an approval request is about ───────────────────────────── */

/** One file in a patch: the path and the diff that will be written to it. */
export interface FileUpdate {
  path: string
  diff: string
}

/**
 * Cap on tracked items. A turn that edits hundreds of files must not grow this
 * without bound; only the item currently awaiting approval is ever read.
 */
const MAX_TRACKED_ITEMS = 200

/** `FileUpdateChange[]`, as carried by `item/started` and `patchUpdated`. */
export function fileUpdates(value: unknown): FileUpdate[] {
  if (!Array.isArray(value)) return []
  const updates: FileUpdate[] = []
  for (const raw of value) {
    if (!isPlainObject(raw)) continue
    const path = str(raw.path)
    if (path) updates.push({ path, diff: str(raw.diff) })
  }
  return updates
}

/**
 * What the notification stream said about each item, kept for the approval
 * request that names it.
 *
 * `FileChangeRequestApprovalParams` carries `grantRoot`, `itemId`, `reason`,
 * `startedAtMs`, `threadId` and `turnId` — and nothing else. There is no path
 * and no diff on it at all, so the approval card was headed "Codex wants to
 * edit files" with the literal word "files" as its detail: the user was asked
 * to approve a write with no way to see what it would write. What is being
 * changed arrives earlier, on `item/started` (a `fileChange` item, whose
 * `changes` the schema makes required) and on `item/fileChange/patchUpdated` —
 * both of which the default branch of `codexNotification` used to drop.
 */
export class CodexItems {
  private readonly changes = new Map<string, FileUpdate[]>()
  private readonly commands = new Map<string, string>()
  /**
   * Agent-message text already emitted from `item/agentMessage/delta`.
   * `item/completed` and `turn/completed` repeat the full text; without this
   * a short reply would be shown twice.
   */
  private readonly streamedAgentText = new Map<string, string>()
  private readonly emittedAgentItems = new Set<string>()
  private readonly agentPhases = new Map<string, 'commentary' | 'partial_answer' | 'final_answer'>()

  agentPhase(id: string): 'commentary' | 'partial_answer' | 'final_answer' | undefined {
    return this.agentPhases.get(id)
  }

  /** Separate distinct messages from a CLI turn while keeping its deltas contiguous. */
  agentTextPrefix(id: string): string {
    if (!id || this.emittedAgentItems.has(id)) return ''
    const prefix = this.emittedAgentItems.size ? '\n\n' : ''
    this.emittedAgentItems.add(id)
    return prefix
  }

  /** Record anything a later approval request or reply might need. Cheap and total. */
  observe(method: string, params: unknown): void {
    if (!isPlainObject(params)) return

    if (method === 'item/agentMessage/delta') {
      this.noteAgentDelta(str(params.itemId), str(params.delta))
      return
    }
    if (method === 'item/fileChange/patchUpdated') {
      this.rememberChanges(str(params.itemId), fileUpdates(params.changes))
      return
    }
    if (method !== 'item/started' && method !== 'item/completed') return

    const item = isPlainObject(params.item) ? params.item : null
    const id = item ? str(item.id) : ''
    if (!item || !id) return
    if (item.type === 'agentMessage' && (item.phase === 'commentary' || item.phase === 'partial_answer' || item.phase === 'final_answer')) {
      this.remember(this.agentPhases, id, item.phase)
    } else if (item.type === 'fileChange') {
      this.rememberChanges(id, fileUpdates(item.changes))
    } else if (item.type === 'commandExecution') {
      const command = str(item.command) || joinCommand(item.command)
      if (command) this.remember(this.commands, id, command)
    }
  }

  /** The patch this item will apply, empty when the stream never described it. */
  fileChange(itemId: string): FileUpdate[] {
    return (itemId && this.changes.get(itemId)) || []
  }

  /** The command this item will run, empty when the stream never described it. */
  command(itemId: string): string {
    return (itemId && this.commands.get(itemId)) || ''
  }

  /**
   * The part of a finished agentMessage that deltas have not already streamed.
   *
   * Recording the full text here means a later `turn/completed` payload, which
   * repeats the same item, does not append it again.
   */
  consumeAgentText(item: Record<string, unknown>): string {
    if (item.type !== 'agentMessage') return ''
    const full = str(item.text)
    const id = str(item.id)
    const seen = id ? (this.streamedAgentText.get(id) ?? '') : ''
    const extra = !seen ? full : full.startsWith(seen) ? full.slice(seen.length) : ''
    if (id && full.startsWith(seen) && full) this.remember(this.streamedAgentText, id, full)
    return extra
  }

  private noteAgentDelta(id: string, delta: string): void {
    if (!id || !delta) return
    this.remember(this.streamedAgentText, id, (this.streamedAgentText.get(id) ?? '') + delta)
  }

  private rememberChanges(itemId: string, updates: FileUpdate[]): void {
    if (!itemId || updates.length === 0) return
    this.remember(this.changes, itemId, updates)
  }

  /** Insertion order is age order, so the oldest key is the one to drop. */
  private remember<T>(store: Map<string, T>, key: string, value: T): void {
    store.set(key, value)
    if (store.size <= MAX_TRACKED_ITEMS) return
    const oldest = store.keys().next()
    if (!oldest.done) store.delete(oldest.value)
  }
}
