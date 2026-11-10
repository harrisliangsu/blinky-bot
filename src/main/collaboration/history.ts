/** Public history only. Cursors are scoped to one invitation and survive appends. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Message } from '../../shared/types'
import { visibleAssistantText } from '../../shared/messagePresentation'

const cursorKey = randomBytes(32)
const pageSize = 50
interface Scope { id: string; sessionId: string; token: string }
export class RoomHistoryError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function signature(payload: string, scope: Scope): Buffer {
  return createHmac('sha256', cursorKey).update(JSON.stringify([scope.id, scope.sessionId, scope.token, payload])).digest()
}
function cursor(id: string, scope: Scope): string {
  const payload = Buffer.from(id).toString('base64url')
  return payload + '.' + signature(payload, scope).toString('base64url')
}
function anchor(value: string, messages: Message[], scope: Scope): number {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new RoomHistoryError(400, 'Invalid history cursor.')
  const [payload, mac] = value.split('.') as [string, string]
  const expected = signature(payload, scope), actual = Buffer.from(mac, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RoomHistoryError(400, 'Invalid history cursor.')
  const id = Buffer.from(payload, 'base64url').toString('utf8')
  const index = messages.findIndex(message => message.id === id)
  if (index < 0) throw new RoomHistoryError(409, 'History changed. Reconnect to refresh it.')
  return index
}
export function publicRoomMessage(message: Message) {
  if (message.internal || message.uiOnly || !['user', 'assistant'].includes(message.role)) return null
  const content = message.role === 'user' ? message.content : visibleAssistantText(message, true)
  if (!content.trim() && !message.attachments?.length && !message.error) return null
  return { id: message.id, role: message.role, author: message.role === 'user' ? 'Participant' : 'BlinkyBot', content, createdAt: message.createdAt, ...(message.botId ? { botId: message.botId } : {}), streaming: message.streaming === true }
}
export function roomHistory(messages: Message[], scope: Scope, query: URLSearchParams) {
  const before = query.get('before'), after = query.get('after')
  if ((before !== null && after !== null) || query.getAll('before').length > 1 || query.getAll('after').length > 1) throw new RoomHistoryError(400, 'Use one history cursor.')
  // Array order is the stored conversation order, including equal/backdated timestamps.
  const start = after !== null ? anchor(after, messages, scope) : 0
  const end = before !== null ? anchor(before, messages, scope) : messages.length
  const count = before !== null ? pageSize : pageSize * 2
  const visible: Array<{ message: NonNullable<ReturnType<typeof publicRoomMessage>> }> = []
  const forward = after !== null
  for (let index = forward ? start : end - 1; forward ? index < end : index >= start; index += forward ? 1 : -1) {
    const message = messages[index]!
    const projected = publicRoomMessage(message)
    if (!projected) continue
    visible.push({ message: projected })
    if (visible.length > count) break
  }
  const selected = visible.slice(0, count)
  if (!forward) selected.reverse()
  const first = selected[0], last = selected.at(-1)
  return {
    messages: selected.map(item => item.message),
    history: {
      olderCursor: first ? cursor(first.message.id, scope) : null,
      newerCursor: last ? cursor(last.message.id, scope) : after,
      hasMore: after === null && visible.length > selected.length,
      hasNewer: after !== null && visible.length > selected.length
    }
  }
}
