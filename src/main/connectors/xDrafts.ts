import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { XDraft } from '../../shared/drafts'
import { broadcast } from '../agent/events'
import { getBot } from '../store/bots'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { readXCredentials } from './xSecrets'
import { postXMessage } from './xOAuth'

let cached: XDraft[] | undefined, queue: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'x-drafts.json')
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }
function valid(raw: unknown): raw is XDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const d = raw as XDraft
  return ['id', 'sessionId', 'botId', 'receiverBotId'].every((key) => typeof d[key as keyof XDraft] === 'string' && !!d[key as keyof XDraft]) && typeof d.userId === 'string' && /^\d{1,32}$/.test(d.userId) && typeof d.username === 'string' && /^[A-Za-z0-9_]{1,30}$/.test(d.username) && typeof d.text === 'string' && !!d.text.trim() && d.text.length <= 4000 &&
    (d.replyToPostId === undefined || (typeof d.replyToPostId === 'string' && /^\d{1,32}$/.test(d.replyToPostId))) && ['draft', 'sending', 'sent', 'uncertain', 'cancelled'].includes(d.status) && (d.feedbackStatus === undefined || ['pending', 'delivering', 'delivered', 'uncertain'].includes(d.feedbackStatus)) && Number.isFinite(d.createdAt) && Number.isFinite(d.updatedAt) && (d.remoteId === undefined || /^\d{1,32}$/.test(d.remoteId))
}
async function load(): Promise<XDraft[]> {
  if (cached) return cached
  let raw: string; try { raw = await readFile(file(), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (cached = []); throw new Error('X drafts could not be read.') }
  let parsed: unknown; try { parsed = JSON.parse(raw) } catch { throw new Error('X draft storage is damaged; it was not changed.') }
  if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error('X draft storage is invalid; it was not changed.')
  if (parsed.some((d) => d.status === 'sending' || d.feedbackStatus === 'delivering')) {
    const recovered: XDraft[] = parsed.map((d) => ({ ...d, ...(d.status === 'sending' ? { status: 'uncertain' as const, feedbackStatus: 'pending' as const, updatedAt: Date.now() } : {}), ...(d.feedbackStatus === 'delivering' ? { feedbackStatus: 'uncertain' as const } : {}) }))
    await writeJsonNow(file(), recovered); return (cached = recovered)
  }
  return (cached = parsed)
}
async function save(records: XDraft[]): Promise<void> { await writeJsonNow(file(), records); cached = records }
export async function createXDraft(sessionId: string, botId: string, text: string, replyToPostId?: string): Promise<XDraft> {
  return serial(async () => {
    const session = getSession(sessionId)
    if (!session || !session.botIds.includes(botId) || !getBot(botId)) throw new Error('This Bot does not belong to this conversation.')
    const task = listTasks().find((item) => item.sessionId === sessionId && item.botId === botId && item.sourceSessionId)
    const source = task?.sourceSessionId ? getSession(task.sourceSessionId) : session
    if (!source || source.archived) throw new Error('The originating conversation is unavailable.')
    const account = await readXCredentials(); if (!account) throw new Error('X is not connected.')
    const clean = typeof text === 'string' ? text.trim() : ''
    if (!clean || clean.length > 4000) throw new Error('Provide a post of at most 4000 characters.')
    if (replyToPostId !== undefined && !/^\d{1,32}$/.test(replyToPostId)) throw new Error('Provide a valid numeric X post id to reply to.')
    const records = await load(), receiverBotId = task ? (task.requesterBotId ?? task.botId) : botId
    const existing = records.find((d) => d.sessionId === source.id && d.botId === botId && d.userId === account.userId && d.status === 'draft' && d.text === clean && d.replyToPostId === replyToPostId)
    if (existing) return existing
    const now = Date.now(), draft: XDraft = { id: randomUUID(), sessionId: source.id, botId, receiverBotId, userId: account.userId, username: account.username, text: clean, ...(replyToPostId ? { replyToPostId } : {}), status: 'draft', createdAt: now, updatedAt: now }
    await save([...records, draft]); broadcast({ type: 'x-draft-updated', draft }); return draft
  })
}
export async function listXDrafts(sessionId: string): Promise<XDraft[]> { return serial(async () => (await load()).filter((d) => d.sessionId === sessionId).map((d) => ({ ...d }))) }
export async function pendingXFeedback(): Promise<XDraft[]> { return serial(async () => (await load()).filter((d) => d.feedbackStatus === 'pending').map((d) => ({ ...d }))) }
export async function setXFeedback(id: string, from: XDraft['feedbackStatus'], to: XDraft['feedbackStatus']): Promise<XDraft | null> {
  return serial(async () => { const records = await load(), current = records.find((d) => d.id === id); if (!current || current.feedbackStatus !== from) return null; const next = { ...current, feedbackStatus: to }; await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'x-draft-updated', draft: next }); return next })
}
/** Only the trusted renderer can request this; an uncertain post is never replayed. */
export async function actOnXDraft(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<XDraft> {
  const started = await serial(async () => {
    const records = await load(), current = records.find((d) => d.id === id && d.sessionId === sessionId)
    if (!current || current.status !== 'draft') throw new Error('This draft is no longer available.')
    if (action === 'send') { const account = await readXCredentials(); if (!account || account.userId !== current.userId) throw new Error('The X account for this draft is not connected.') }
    const next: XDraft = { ...current, status: action === 'send' ? 'sending' : 'cancelled', ...(action === 'cancel' ? { feedbackStatus: 'pending' as const } : {}), updatedAt: Date.now() }
    await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'x-draft-updated', draft: next }); return next
  })
  if (action === 'cancel') return started
  let result: XDraft
  try { result = { ...started, status: 'sent', feedbackStatus: 'pending', updatedAt: Date.now(), remoteId: await postXMessage(started.userId, started.text, started.replyToPostId) } }
  catch { result = { ...started, status: 'uncertain', feedbackStatus: 'pending', updatedAt: Date.now() } }
  return serial(async () => { let next = result; const records = (await load()).map((d) => d.id === id ? next : d); try { await save(records) } catch { next = { ...started, status: 'uncertain', feedbackStatus: 'uncertain', updatedAt: Date.now() }; cached = records.map((d) => d.id === id ? next : d) }; broadcast({ type: 'x-draft-updated', draft: next }); return next })
}
