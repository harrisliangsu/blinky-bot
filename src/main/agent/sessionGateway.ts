/**
 * Session and bot reads/writes.
 *
 * A thin layer over the stores: it keeps the loop's async surface, and defaults the
 * fields the loop relies on (`computerTarget`, the message and todo arrays) so a bot
 * or session written by an older build cannot crash a turn.
 *
 * There is deliberately no `save(session)` here. A turn holds one `Session` for its
 * whole length, across every stream and tool await, while the user renames the chat,
 * an agent CLI writes todos through the MCP gateway, and messages are appended. Saving
 * that held object verbatim writes a snapshot over everything those wrote — the store
 * persists exactly what it is handed, by contract. `update` is the only write path, and
 * it refreshes before it mutates.
 */

import type { Bot, Session } from '../../shared/types'
import { getBot, listBots } from '../store/bots'
import { getSession, saveSession } from '../store/sessions'
import { errorMessage } from './errors'

/** Bots always drive this machine unless they say otherwise. */
function withDefaults(bot: Bot): Bot {
  return bot.computerTarget ? bot : { ...bot, computerTarget: { kind: 'local' } }
}

/**
 * Bring `target` up to date with the store's copy, in place.
 *
 * In place, because the turn, its tool contexts and the routine replayer all hold this
 * exact reference: handing back a new object would leave them on the old one.
 *
 * Messages `target` holds but the store does not are kept and re-appended at the end.
 * That only happens when an earlier save failed, and without it this refresh would turn
 * a failed save into a deletion.
 */
function adopt(target: Session, source: Session): void {
  const persisted = new Set(source.messages.map((message) => message.id))
  const unsaved = target.messages.filter((message) => !persisted.has(message.id))

  for (const key of Object.keys(target)) {
    if (!(key in source)) delete (target as unknown as Record<string, unknown>)[key]
  }
  Object.assign(target, source)
  if (unsaved.length > 0) target.messages = [...source.messages, ...unsaved]
}

/** The store's copy, with the arrays the loop indexes into guaranteed to exist. */
function load(id: string): Session | null {
  const session = getSession(id)
  if (!session) return null
  if (!Array.isArray(session.messages)) session.messages = []
  if (!Array.isArray(session.todos)) session.todos = []
  if (!Array.isArray(session.botIds)) session.botIds = []
  return session
}

export const sessions = {
  async get(id: string): Promise<Session | null> {
    return load(id)
  },

  /**
   * Pull in whatever has been written since, without persisting anything.
   *
   * For the points where the loop *reads* long-held state and a wrong answer costs more
   * than a stale one — which bot holds the floor, most of all. Returns false when the
   * session is gone from the store.
   */
  async refresh(session: Session): Promise<boolean> {
    const stored = load(session.id)
    if (!stored) return false
    if (stored !== session) adopt(session, stored)
    return true
  },

  /**
   * Refresh `session` from the store, apply `change` to it, and persist the result.
   *
   * `change` must be synchronous, and that is the whole design: `getSession` and
   * `saveSession` are synchronous too, so refresh-mutate-save runs to completion without
   * yielding. Nothing can interleave between the read and the write, which is what makes
   * this safe without a lock — and a lock would not have helped, since two loads racing
   * one save is the same lost update in a different shape.
   *
   * Appends therefore land after whatever arrived while the turn was awaiting, so message
   * order follows real time. Concurrent sessions are untouched: each call reads and writes
   * one id.
   *
   * Returns false when the session is no longer in the store. The change is still applied
   * to the caller's object so the turn can finish coherently, but nothing is written: a
   * chat the user deleted mid-turn must stay deleted.
   */
  async update(session: Session, change: (session: Session) => void): Promise<boolean> {
    const stored = load(session.id)
    if (!stored) {
      change(session)
      return false
    }
    if (stored !== session) adopt(session, stored)
    // Do not mutate the cache before the database transaction commits. A
    // failed write must never look durable to queue delivery or the model.
    const draft = structuredClone(session)
    change(draft)
    try {
      const saved = saveSession(draft)
      adopt(session, saved)
    } catch (err) {
      console.warn(`[agent] session save failed: ${errorMessage(err)}`)
      return false
    }
    return true
  }
}

export const bots = {
  async get(id: string): Promise<Bot | null> {
    if (!id) return null
    const bot = getBot(id)
    return bot ? withDefaults(bot) : null
  },

  async list(): Promise<Bot[]> {
    return listBots().map(withDefaults)
  },

  /** Resolve several ids, preserving order and skipping ones that no longer exist. */
  async many(ids: string[]): Promise<Bot[]> {
    const found = await Promise.all(ids.map((id) => bots.get(id)))
    return found.filter((bot): bot is Bot => bot !== null)
  }
}
