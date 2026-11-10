import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CalendarDraft } from '../../shared/drafts'
import { broadcast } from '../agent/events'
import { getBot } from '../store/bots'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { readGoogleCredentials } from './googleSecrets'
import { createCalendarEvent } from './googleOAuth'
import { validMailAddress } from './gmailMime'

type DraftInput = Pick<CalendarDraft, 'summary' | 'start' | 'end' | 'description' | 'attendees'>
let cached: CalendarDraft[] | undefined, queue: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'calendar-drafts.json')
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }
function validInput(input: DraftInput): boolean {
  const from = Date.parse(input.start), to = Date.parse(input.end)
  return typeof input.summary === 'string' && !!input.summary.trim() && input.summary.length <= 300 && typeof input.description === 'string' && input.description.length <= 20_000 &&
    typeof input.start === 'string' && typeof input.end === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(input.start) && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(input.end) && Number.isFinite(from) && Number.isFinite(to) && to > from &&
    (input.attendees === undefined || (Array.isArray(input.attendees) && input.attendees.length <= 50 && input.attendees.every((address) => typeof address === 'string' && validMailAddress(address)) && new Set(input.attendees.map((address) => address.toLowerCase())).size === input.attendees.length))
}
function valid(raw: unknown): raw is CalendarDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const d = raw as CalendarDraft
  return ['id','sessionId','botId','receiverBotId','account'].every((key) => typeof d[key as keyof CalendarDraft] === 'string' && !!d[key as keyof CalendarDraft]) && validInput(d) &&
    ['draft','sending','sent','uncertain','cancelled'].includes(d.status) && (d.feedbackStatus === undefined || ['pending','delivering','delivered','uncertain'].includes(d.feedbackStatus)) &&
    Number.isFinite(d.createdAt) && Number.isFinite(d.updatedAt) && (d.remoteId === undefined || /^[A-Za-z0-9_-]{1,1024}$/.test(d.remoteId))
}
async function load(): Promise<CalendarDraft[]> {
  if (cached) return cached
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = []); throw new Error('Calendar drafts could not be read.') }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Calendar draft storage is damaged; it was not changed.') }
  if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error('Calendar draft storage is invalid; it was not changed.')
  if (parsed.some((d) => d.status === 'sending' || d.feedbackStatus === 'delivering')) {
    const recovered: CalendarDraft[] = parsed.map((d) => ({ ...d, ...(d.status === 'sending' ? { status: 'uncertain' as const, feedbackStatus: 'pending' as const, updatedAt: Date.now() } : {}), ...(d.feedbackStatus === 'delivering' ? { feedbackStatus: 'uncertain' as const } : {}) }))
    await writeJsonNow(file(), recovered); return (cached = recovered)
  }
  return (cached = parsed)
}
async function save(records: CalendarDraft[]): Promise<void> { await writeJsonNow(file(), records); cached = records }
export async function createCalendarDraft(sessionId: string, botId: string, input: DraftInput): Promise<CalendarDraft> {
  return serial(async () => {
    const session = getSession(sessionId)
    if (!session || !session.botIds.includes(botId) || !getBot(botId)) throw new Error('This Bot does not belong to this conversation.')
    const task = listTasks().find((item) => item.sessionId === sessionId && item.botId === botId && item.sourceSessionId)
    const source = task?.sourceSessionId ? getSession(task.sourceSessionId) : session
    if (!source || source.archived) throw new Error('The originating conversation is unavailable.')
    const account = await readGoogleCredentials('calendar')
    if (!account) throw new Error('Google Calendar is not connected.')
    if (!validInput(input)) throw new Error('Provide a title, valid times with time zones and up to 50 distinct email addresses.')
    const clean = { summary: input.summary.trim(), start: input.start, end: input.end, description: input.description.trim(), ...(input.attendees?.length ? { attendees: [...input.attendees] } : {}) }
    const records = await load(), receiverBotId = task ? (task.requesterBotId ?? task.botId) : botId
    const existing = records.find((d) => d.sessionId === source.id && d.botId === botId && d.account === account.account && d.status === 'draft' && d.summary === clean.summary && d.start === clean.start && d.end === clean.end && d.description === clean.description && JSON.stringify(d.attendees ?? []) === JSON.stringify(clean.attendees ?? []))
    if (existing) return existing
    const now = Date.now(), draft: CalendarDraft = { id: randomUUID(), sessionId: source.id, botId, receiverBotId, account: account.account, ...clean, status: 'draft', createdAt: now, updatedAt: now }
    await save([...records, draft]); broadcast({ type: 'calendar-draft-updated', draft }); return draft
  })
}
export async function listCalendarDrafts(sessionId: string): Promise<CalendarDraft[]> { return serial(async () => (await load()).filter((d) => d.sessionId === sessionId).map((d) => ({ ...d }))) }
export async function pendingCalendarFeedback(): Promise<CalendarDraft[]> { return serial(async () => (await load()).filter((d) => d.feedbackStatus === 'pending').map((d) => ({ ...d }))) }
export async function setCalendarFeedback(id: string, from: CalendarDraft['feedbackStatus'], to: CalendarDraft['feedbackStatus']): Promise<CalendarDraft | null> {
  return serial(async () => { const records = await load(), current = records.find((d) => d.id === id); if (!current || current.feedbackStatus !== from) return null; const next = { ...current, feedbackStatus: to }; await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'calendar-draft-updated', draft: next }); return next })
}
export async function actOnCalendarDraft(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<CalendarDraft> {
  const started = await serial(async () => {
    const records = await load(), current = records.find((d) => d.id === id && d.sessionId === sessionId)
    if (!current || current.status !== 'draft') throw new Error('This draft is no longer available.')
    if (action === 'send') { const account = await readGoogleCredentials('calendar'); if (!account || account.account.toLowerCase() !== current.account.toLowerCase()) throw new Error('The calendar account for this draft is not connected.') }
    const next: CalendarDraft = { ...current, status: action === 'send' ? 'sending' : 'cancelled', ...(action === 'cancel' ? { feedbackStatus: 'pending' as const } : {}), updatedAt: Date.now() }
    await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'calendar-draft-updated', draft: next }); return next
  })
  if (action === 'cancel') return started
  let result: CalendarDraft
  try { result = { ...started, status: 'sent', feedbackStatus: 'pending', updatedAt: Date.now(), remoteId: await createCalendarEvent(started, started.account) } }
  catch { result = { ...started, status: 'uncertain', feedbackStatus: 'pending', updatedAt: Date.now() } }
  return serial(async () => {
    let next = result; const records = (await load()).map((d) => d.id === id ? next : d)
    try { await save(records) } catch { next = { ...started, status: 'uncertain', feedbackStatus: 'uncertain', updatedAt: Date.now() }; cached = records.map((d) => d.id === id ? next : d) }
    broadcast({ type: 'calendar-draft-updated', draft: next }); return next
  })
}
