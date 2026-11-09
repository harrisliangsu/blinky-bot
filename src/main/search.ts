/** In-memory full-content search over the local stores. No indexing service or upload. */

import type { Message, SearchResult } from '../shared/types'
import { listBots } from './store/bots'
import { listRoutines } from './store/routines'
import { allSessions } from './store/sessions'

/**
 * Named `LINK`, not `URL`: a module-level `const URL` shadows the global `URL`
 * constructor for this entire file, so the first `new URL(...)` written here
 * would fail with nothing pointing at the cause.
 */
const LINK = /https?:\/\/[^\s<>()\]]+/gi

/**
 * Messages one query may look at.
 *
 * This runs on the main process — the one driving the agent loop — once per
 * keystroke, and the `limit * 4` cap below bounds the *output*, not the work.
 * Sessions are visited newest first so the budget is spent where a match is
 * most likely to be wanted.
 */
const MAX_SCANNED_MESSAGES = 20_000

/** `includeArchived` is opt-in: archived chats are what the user filed away. */
export function searchAll(raw: string, requestedLimit = 50, includeArchived = false, projectMessage?: (message: Message) => Message | null, projectText: (value: string) => string = value => value): SearchResult[] {
  const query = raw.trim().toLocaleLowerCase()
  if (!query) return []
  const limit = Math.max(1, Math.min(100, Math.round(requestedLimit) || 50))
  const results: SearchResult[] = []
  /** Room for ranking to choose from, without collecting the whole store. */
  const cap = limit * 4
  const add = (result: SearchResult): void => {
    if (results.length < cap) results.push(result)
  }
  const visible = (value: string | undefined): string => projectText(value ?? '')
  const matches = (value: string | undefined): boolean => visible(value).toLocaleLowerCase().includes(query)

  const sessions = allSessions()
    .filter((session) => includeArchived || !session.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  let scanned = 0
  scan: for (const session of sessions) {
    const messages = projectMessage ? session.messages.map(projectMessage).filter((message): message is Message => !!message) : session.messages
    if (matches(session.title)) {
      add({ id: `conversation:${session.id}`, kind: 'conversation', title: visible(session.title), snippet: `${messages.length} messages`, updatedAt: session.updatedAt, sessionId: session.id })
    }
    for (const message of messages) {
      // Out of budget, or already holding everything ranking will look at —
      // once the buffer is full every further `add` is a no-op, so reading on
      // changes no result and only costs time.
      if (scanned >= MAX_SCANNED_MESSAGES || results.length >= cap) break scan
      scanned += 1
      // Folded once and reused: this was three separate `toLocaleLowerCase()`
      // passes over the same content, per message, per keystroke.
      const safeContent = visible(message.content)
      const content = safeContent.toLocaleLowerCase()
      const hit = content.includes(query)
      if (hit || matches(message.reasoning)) {
        add({
          id: `message:${session.id}:${message.id}`,
          kind: 'message',
          title: visible(session.title),
          snippet: excerpt(`${safeContent}\n${visible(message.reasoning)}`, query),
          updatedAt: message.createdAt,
          sessionId: session.id
        })
      }
      for (const attachment of message.attachments ?? []) {
        if (matches(attachment.name) || matches(attachment.path)) {
          add({
            id: `file:${session.id}:${message.id}:${attachment.id}`,
            kind: 'file',
            title: visible(attachment.name),
            snippet: attachment.path ? visible(attachment.path) : `Attached in ${visible(session.title)}`,
            updatedAt: message.createdAt,
            sessionId: session.id
          })
        }
      }
      /*
       * The link scan is the expensive half — it used to build an array of
       * every URL in every message on every keystroke. A link can only be a
       * result when it contains the query, and a link is a substring of the
       * content, so a message the query does not appear in cannot contribute
       * one. `://` then rules out the messages that hold no link at all.
       */
      if (hit && content.includes('://')) {
        for (const [link] of safeContent.matchAll(LINK)) {
          if (matches(link)) {
            add({ id: `link:${session.id}:${message.id}:${link}`, kind: 'link', title: link, snippet: `Linked in ${visible(session.title)}`, updatedAt: message.createdAt, sessionId: session.id })
          }
        }
      }
    }
  }

  for (const bot of listBots()) {
    if (matches(bot.name) || matches(bot.description) || matches(bot.systemPrompt)) {
      add({ id: `bot:${bot.id}`, kind: 'bot', title: visible(bot.name), snippet: excerpt(`${visible(bot.description)}\n${visible(bot.systemPrompt)}`, query), updatedAt: bot.updatedAt, botId: bot.id })
    }
  }
  for (const routine of listRoutines()) {
    const stepText = routine.steps.map((step) => `${step.kind} ${visible(step.intent)}`).join('\n')
    if (matches(routine.name) || matches(routine.description) || matches(stepText)) {
      add({ id: `routine:${routine.id}`, kind: 'routine', title: visible(routine.name), snippet: excerpt(`${visible(routine.description)}\n${stepText}`, query), updatedAt: routine.lastRunAt ?? routine.createdAt, routineId: routine.id })
    }
  }

  return results.sort((a, b) => score(b, query) - score(a, query) || b.updatedAt - a.updatedAt).slice(0, limit)
}

function score(result: SearchResult, query: string): number {
  const title = result.title.toLocaleLowerCase()
  return title === query ? 100 : title.startsWith(query) ? 50 : title.includes(query) ? 20 : 0
}

function excerpt(value: string, query: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  const at = clean.toLocaleLowerCase().indexOf(query)
  if (at < 0) return clean.slice(0, 180)
  const start = Math.max(0, at - 65)
  const end = Math.min(clean.length, at + query.length + 100)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}
