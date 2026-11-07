/** Single-use Gmail intent from the trusted renderer, never from a model or daemon. */
import { createHash } from 'node:crypto'
import type { Attachment } from '../../shared/chat'
import type { GmailDraft } from '../../shared/drafts'
import { actOnGmailDraft, listGmailDrafts } from '../connectors/gmailDrafts'
import { getBot } from '../store/bots'
import { getSession, isSessionMessageDurable } from '../store/sessions'
import { flushAll } from '../store/jsonStore'
import { addNotice, addUserMessage } from './messages'
import { sessions } from './sessionGateway'
import { queueSuspensionGeneration } from './messageQueueRuntime'

interface Presentation { id: string; fingerprint: string }
const presented = new Map<string, Presentation>()
const admission = new Map<string, Promise<void>>()
const key = (webContentsId: number, sessionId: string, draftId: string): string => `${webContentsId}:${sessionId}:${draftId}`
const fingerprint = (draft: GmailDraft): string => createHash('sha256').update(JSON.stringify([draft.id, draft.sessionId, draft.botId, draft.receiverBotId, draft.accountId ?? null, draft.senderAccount, draft.to, draft.subject, draft.body, draft.createdAt, draft.updatedAt])).digest('hex')

/** Deliberately anchored: quoted emails, attachments and broad NLP are not authorization. */
export function isExactGmailSendIntent(text: string, attachments: readonly Attachment[]): boolean {
  return attachments.length === 0 && /^(?:发送|发送这封草稿|发送这封邮件|send this draft|send this email)[。.!！]?$/i.test(text.trim())
}

function sourceContext(sessionId: string) {
  const source = getSession(sessionId), bot = source?.activeBotId ? getBot(source.activeBotId) : null
  if (!source || source.archived || source.mode !== 'agent' || !bot || bot.archived || !source.botIds.includes(bot.id)) return null
  return { source, bot }
}

function belongsToSource(draft: GmailDraft, sessionId: string, receiverBotId: string): boolean {
  const context = sourceContext(sessionId), author = getBot(draft.botId)
  return Boolean(context && context.bot.id === receiverBotId && context.source.botIds.includes(draft.botId) && author && !author.archived && draft.sessionId === sessionId && draft.receiverBotId === receiverBotId)
}

/** Called only by the event-sensitive IPC after a card enters the visible viewport.
 * This records presentation, not whether a person actually read its contents. */
export async function markGmailDraftPresented(webContentsId: number, id: string, sessionId: string, updatedAt: number): Promise<boolean> {
  if (!Number.isInteger(webContentsId) || webContentsId < 0 || !Number.isFinite(updatedAt)) return false
  const context = sourceContext(sessionId)
  if (!context) return false
  const draft = (await listGmailDrafts(sessionId)).find(value => value.id === id)
  if (!draft || draft.status !== 'draft' || draft.updatedAt !== updatedAt || !belongsToSource(draft, sessionId, context.bot.id)) return false
  presented.set(key(webContentsId, sessionId, id), { id, fingerprint: fingerprint(draft) })
  return true
}

function wasPresented(webContentsId: number, draft: GmailDraft): boolean {
  const seen = presented.get(key(webContentsId, draft.sessionId, draft.id))
  return Boolean(seen && seen.id === draft.id && seen.fingerprint === fingerprint(draft))
}

async function serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = admission.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  admission.set(sessionId, current)
  await previous
  try { return await work() } finally { release(); if (admission.get(sessionId) === current) admission.delete(sessionId) }
}

async function notice(sessionId: string, botId: string | undefined, text: string): Promise<void> {
  const source = await sessions.get(sessionId)
  if (source) await addNotice(source, botId ? getBot(botId) : null, text, undefined, undefined, true)
}

async function sendOnce(webContentsId: number, draft: GmailDraft, receiverBotId: string, generation: number): Promise<void> {
  try {
    const stillAuthorized = () => queueSuspensionGeneration(draft.sessionId) === generation && wasPresented(webContentsId, draft) && belongsToSource(draft, draft.sessionId, receiverBotId)
    const result = await actOnGmailDraft(draft.id, draft.sessionId, 'send', current => current.status === 'draft' && wasPresented(webContentsId, current) && stillAuthorized(), stillAuthorized)
    await notice(draft.sessionId, receiverBotId, result.status === 'sent'
      ? 'Gmail 已接受发送请求；是否送达收件人尚未确认。'
      : result.status === 'draft' ? '发送请求尚未发出，草稿已保留。若仍需发送，请重新查看草稿并确认。'
        : '发送结果未确认，请先检查 Gmail 已发送邮件；应用不会自动重发。')
  } catch {
    await notice(draft.sessionId, receiverBotId, '这次发送未完成。请检查 Gmail 连接、草稿状态及当前 Bot 归属；应用不会自动重试。').catch(() => undefined)
  }
}

/** A recognized command is consumed even when ambiguous or unavailable. The
 * original message is durable before any send claim; the network never holds
 * the main chat's run/queue or input open. Only trusted renderer IPC calls this. */
export async function consumeGmailUserIntent(webContentsId: number, sessionId: string, text: string, attachments: readonly Attachment[]): Promise<{ consumed: boolean; accepted: boolean }> {
  if (!isExactGmailSendIntent(text, attachments)) return { consumed: false, accepted: false }
  return serial(sessionId, async () => {
    const source = await sessions.get(sessionId)
    if (!source) return { consumed: true, accepted: false }
    const context = sourceContext(sessionId), botId = context?.bot.id, generation = queueSuspensionGeneration(sessionId)
    try {
      const message = await addUserMessage(source, text.trim(), undefined, true)
      const saved = await flushAll()
      if (saved.failed.length || saved.stillWriting || !isSessionMessageDurable(sessionId, message.id)) throw new Error('The user message is not durable.')
    } catch { return { consumed: true, accepted: false } }
    if (!context || !sourceContext(sessionId) || sourceContext(sessionId)!.bot.id !== botId) {
      await notice(sessionId, botId, '当前聊天或 Bot 已不可用，未发送邮件。').catch(() => undefined)
      return { consumed: true, accepted: true }
    }
    let drafts: GmailDraft[]
    try { drafts = await listGmailDrafts(sessionId) }
    catch {
      await notice(sessionId, botId, '草稿无法安全读取，未发送邮件。请先检查本机数据。').catch(() => undefined)
      return { consumed: true, accepted: true }
    }
    const candidates = drafts.filter(draft => draft.status === 'draft')
    if (candidates.length !== 1) {
      await notice(sessionId, botId, candidates.length > 1
        ? '这个聊天里有多封草稿，请在目标草稿卡上确认发送。'
        : drafts.some(draft => draft.status === 'uncertain' || draft.status === 'sending')
          ? '已有发送结果未确认或仍在发送，请先检查 Gmail；应用不会自动重发。'
          : '当前没有可发送的草稿。已取消或已发送的邮件不会再次发送。').catch(() => undefined)
      return { consumed: true, accepted: true }
    }
    const draft = candidates[0]!
    if (!belongsToSource(draft, sessionId, botId!) || !wasPresented(webContentsId, draft)) {
      await notice(sessionId, botId, '请先在当前 Bot 的草稿卡中查看发件人、收件人和正文，再确认发送。').catch(() => undefined)
      return { consumed: true, accepted: true }
    }
    void sendOnce(webContentsId, draft, botId!, generation)
    return { consumed: true, accepted: true }
  })
}
