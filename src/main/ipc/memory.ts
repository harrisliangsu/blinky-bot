/** User-authored memory mutations. Call only from a trusted top-level UI handler. */
import { getBot } from '../store/bots'
import { removeBotMemoryDurable, writeUserMemory } from '../store/memory'
import { asId, asString } from './validate'

export async function saveUserMemory(id: unknown, input: unknown) {
  const botId = asId(id)
  if (!getBot(botId)) throw new Error('此 Bot 不存在。')
  const request = typeof input === 'string' ? { text: input } : input as { text?: unknown; replaceEntryId?: unknown; requestId?: unknown; shared?: unknown; kind?: unknown } | null
  const text = asString(request?.text, 2000).trim()
  if (!text) throw new Error('请填写记忆内容。')
  const kind = request?.kind
  if (kind !== undefined && kind !== 'profile' && kind !== 'journal' && kind !== 'note') throw new Error('记忆类型无效。')
  return writeUserMemory(botId, text, request?.replaceEntryId === undefined ? undefined : asId(request.replaceEntryId), request?.requestId === undefined ? undefined : asId(request.requestId), request?.shared === true, kind)
}

export async function deleteUserMemory(id: unknown, entryId: unknown): Promise<boolean> {
  const botId = asId(id)
  if (!getBot(botId)) throw new Error('此 Bot 不存在。')
  return removeBotMemoryDurable(botId, asId(entryId))
}
