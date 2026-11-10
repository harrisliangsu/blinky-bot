/** Narrow read-only Gmail and Calendar operations; external text is untrusted. */
import { googleApiGet } from './googleOAuth'
import { gmailBody } from './gmailBody'
import { googleAccountId, readGoogleCredentials } from './googleSecrets'

function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid message identifier.')
  return value
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function header(raw: unknown, key: string): string {
  if (!Array.isArray(raw)) return ''
  const found = raw.map(record).find((entry) => typeof entry.name === 'string' && entry.name.toLowerCase() === key.toLowerCase())
  return typeof found?.value === 'string' ? found.value.slice(0, 1000) : ''
}
function message(value: Record<string, unknown>, includeBody: boolean): Record<string, unknown> {
  const payload = record(value.payload)
  return {
    id: typeof value.id === 'string' ? value.id : '',
    threadId: typeof value.threadId === 'string' ? value.threadId : '',
    from: header(payload.headers, 'From'), to: header(payload.headers, 'To'), subject: header(payload.headers, 'Subject'), date: header(payload.headers, 'Date'),
    snippet: typeof value.snippet === 'string' ? value.snippet.slice(0, 1000) : '',
    ...(includeBody ? gmailBody(payload) : {})
  }
}

function pageToken(value?: string): string | undefined {
  if (value !== undefined && (!value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid page token.')
  return value
}

export async function searchGmail(query: string, limit: number, signal?: AbortSignal, token?: string, accountId?: string): Promise<{ messages: Record<string, unknown>[]; nextPageToken?: string }> {
  const clean = query.trim()
  if (clean.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid Gmail search.')
  const selected = await readGoogleCredentials('gmail', accountId)
  if (!selected) throw new Error('The selected Gmail account is not connected.')
  const selectedId = googleAccountId(selected.account)
  const next = pageToken(token)
  const page = await googleApiGet('gmail', '/gmail/v1/users/me/messages', { q: clean, maxResults: String(limit), ...(next ? { pageToken: next } : {}) }, signal, selectedId)
  const messages = Array.isArray(page.messages) ? page.messages.slice(0, limit) : []
  const results = await Promise.all(messages.map(async (item) => {
    const value = record(item)
    if (typeof value.id !== 'string') throw new Error('Gmail returned an invalid message identifier.')
    const result = await googleApiGet('gmail', `/gmail/v1/users/me/messages/${id(value.id)}`, { format: 'metadata' }, signal, selectedId)
    if (result.id !== value.id) throw new Error('Gmail returned a different message.')
    return message(result, false)
  }))
  return { messages: results, ...(typeof page.nextPageToken === 'string' ? { nextPageToken: pageToken(page.nextPageToken) } : {}) }
}

export async function readGmail(messageId: string, signal?: AbortSignal, accountId?: string): Promise<Record<string, unknown>> {
  const result = await googleApiGet('gmail', `/gmail/v1/users/me/messages/${id(messageId)}`, { format: 'full' }, signal, accountId)
  if (result.id !== messageId) throw new Error('Gmail returned a different message.')
  return message(result, true)
}

export async function listCalendarEvents(start: string, end: string, limit: number, signal?: AbortSignal, token?: string, accountId?: string): Promise<{ events: Record<string, unknown>[]; nextPageToken?: string }> {
  const from = Date.parse(start), to = Date.parse(end)
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(start) || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(end) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * 86400_000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Provide a valid calendar interval with time zones, of at most one year.')
  const next = pageToken(token)
  const result = await googleApiGet('calendar', '/calendar/v3/calendars/primary/events', { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), maxResults: String(limit), singleEvents: 'true', orderBy: 'startTime', ...(next ? { pageToken: next } : {}) }, signal, accountId)
  const events = (Array.isArray(result.items) ? result.items : []).slice(0, limit).map((raw) => {
    const item = record(raw), start = record(item.start), end = record(item.end)
    return { id: typeof item.id === 'string' ? item.id : '', summary: typeof item.summary === 'string' ? item.summary.slice(0, 1000) : '', start: start.dateTime ?? start.date ?? '', end: end.dateTime ?? end.date ?? '', location: typeof item.location === 'string' ? item.location.slice(0, 1000) : '', description: typeof item.description === 'string' ? item.description.slice(0, 10_000) : '' }
  })
  return { events, ...(typeof result.nextPageToken === 'string' ? { nextPageToken: pageToken(result.nextPageToken) } : {}) }
}
