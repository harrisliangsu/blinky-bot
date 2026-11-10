/** Public browser projection; never serialize private model/tool/credential fields. */
import type { Message } from '../../shared/types'
import { publicRoomMessage } from './history'
import { scrubVaultTextsNow } from '../store/vault'
import { redactPrivateText } from '../backends/secretRedaction'

const privateKeys = new Set(['password', 'secret', 'secrets', 'token', 'apiKey', 'accessToken', 'refreshToken', 'bearerToken', 'ciphertext', 'privateKey', 'secretKey', 'reasoning', 'agentTrace', 'toolCalls', 'toolResult', 'env', 'headers', 'extraHeaders', 'credentials'])
const privateProtocolKey = /^(?:authorization|cookies?|set[-_]?cookie|password|passphrase|secrets?|credentials?|密码|密钥|令牌)$/i
const structural = /^(?:id|.*Id|.*Ids|role|type|kind|state|status|permission|scope|color|avatarShape|avatarColor|backendId|modelId|mime|fingerprint|inviteUrl)$/

export function publicRemoteMessage(message: Message): Message | null {
  const body = publicRoomMessage(message)
  if (!body) return null
  const result: Message = { id: body.id, role: body.role as 'user' | 'assistant', content: body.content, displayContent: body.content, createdAt: body.createdAt, streaming: body.streaming, ...(body.botId ? { botId: body.botId } : {}) }
  if (message.attachments?.length) result.attachments = message.attachments.map(item => ({ id: item.id, kind: item.kind, name: item.name, ...(item.mime ? { mime: item.mime } : {}), ...(item.kind === 'image' ? { dataRef: item.id } : {}) }))
  if (message.reactions) result.reactions = message.reactions
  if (message.error) result.error = message.error
  // The common desktop renderer only displays explicitly public phases while streaming.
  if (body.role === 'assistant') result.segments = [{ id: 'public-' + body.id, phase: body.streaming ? 'partial_answer' : 'final_answer', text: body.content }]
  return result
}

export function publicRemoteData<T>(input: T): T {
  const texts: string[] = [], slots: Array<{ object: Record<string, unknown> | unknown[]; key: string | number }> = []
  const clone = (value: unknown, key = '', depth = 0): unknown => {
    if (depth > 60) throw new Error('The response is too deeply nested.')
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const item of value) {
        const projected = clone(item, key, depth + 1)
        if (projected === null) continue
        const index = result.length; result.push(projected)
        if (typeof projected === 'string' && !structural.test(key)) { texts.push(projected); slots.push({ object: result, key: index }) }
      }
      return result
    }
    const record = value as Record<string, unknown>
    if (['user', 'assistant', 'tool', 'system'].includes(String(record.role)) && typeof record.id === 'string' && typeof record.content === 'string') {
      const projected = publicRemoteMessage(record as unknown as Message)
      return projected ? collect(projected as unknown as Record<string, unknown>, depth) : null
    }
    return collect(record, depth)
  }
  const collect = (record: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (privateKeys.has(key) || privateProtocolKey.test(key) || key.startsWith('__') || /(?:password|secret|access[_-]?token|refresh[_-]?token|bearer[_-]?token|api[_-]?key|private[_-]?key)$/i.test(key) && typeof value === 'string') continue
      if (typeof value === 'string' && !structural.test(key)) {
        result[key] = value; texts.push(value); slots.push({ object: result, key })
      } else result[key] = clone(value, key, depth + 1)
    }
    return result
  }
  const result = clone(input)
  const checked = scrubVaultTextsNow(texts)
  if (checked.unavailable) throw new Error('Private data could not be checked; nothing was returned.')
  slots.forEach((slot, index) => { (slot.object as Record<string | number, unknown>)[slot.key] = redactPrivateText(checked.texts[index]!) })
  return result as T
}

/** Do not replace stored secrets with a browser's unchanged redacted form fields. */
export function preserveRedactedPatch<T extends Record<string, unknown>>(before: T, patch: Record<string, unknown>): Record<string, unknown> {
  const visible = publicRemoteData(before), result = { ...patch }
  for (const key of Object.keys(result)) {
    if (typeof before[key] === 'string' && visible[key] !== before[key]) {
      if (result[key] === visible[key]) delete result[key]
      else if (typeof result[key] === 'string' && /\[redacted\]|\*\*\*/.test(result[key] as string)) throw new Error('This field contains a local credential. Edit it on the Mac.')
    }
  }
  return result
}
