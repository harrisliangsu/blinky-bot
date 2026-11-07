import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GmailDraft } from '../../shared/drafts'
import { broadcast } from '../agent/events'
import { deniedRuleForCall } from '../agent/approvalPolicy'
import { getSettings } from '../settings'
import { getBot } from '../store/bots'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { isBotBeingRemoved } from '../tasks'
import { readGoogleCredentials } from './googleSecrets'
import { GoogleSendNotStartedError, sendGmailRaw } from './googleOAuth'
import { gmailMime, validMailAddress } from './gmailMime'

type DraftInput = Pick<GmailDraft, 'to' | 'subject' | 'body'> & {accountId?:string}
let cached: GmailDraft[] | undefined, queue: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'gmail-drafts.json')
function serial<T>(fn: () => Promise<T>): Promise<T> { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }

async function load(): Promise<GmailDraft[]> {
  if (cached) return cached
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = []); throw new Error('Mail drafts could not be read.') }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Mail draft storage is damaged; it was not changed.') }
  if (!Array.isArray(parsed) || !parsed.every((d) => d && typeof d.id === 'string' && typeof d.sessionId === 'string' && typeof d.botId === 'string' && typeof d.receiverBotId === 'string' && typeof d.senderAccount === 'string' && typeof d.to === 'string' && typeof d.subject === 'string' && typeof d.body === 'string' && ['draft','sending','sent','uncertain','cancelled'].includes(d.status))) throw new Error('Mail draft storage is invalid; it was not changed.')
  const records = parsed as GmailDraft[]
  if (records.some((d) => d.status === 'sending' || d.feedbackStatus === 'delivering')) {
    const recovered = records.map((d) => ({ ...d, ...(d.status === 'sending' ? { status: 'uncertain' as const, feedbackStatus: 'pending' as const, updatedAt: Date.now() } : {}), ...(d.feedbackStatus === 'delivering' ? { feedbackStatus: 'uncertain' as const } : {}) }))
    await writeJsonNow(file(), recovered); return (cached = recovered)
  }
  return (cached = records)
}
async function save(records: GmailDraft[]): Promise<void> { await writeJsonNow(file(), records); cached = records }
function requestContext(sessionId:string,botId:string):{source:NonNullable<ReturnType<typeof getSession>>;receiverBotId:string;scope?:string}{
  const session=getSession(sessionId),bot=getBot(botId)
  if(!session||!session.botIds.includes(botId)||!bot||bot.archived||isBotBeingRemoved(botId))throw new Error('This Bot does not belong to this conversation.')
  const tasks=listTasks(),related=tasks.filter(item=>item.sessionId===sessionId&&item.botId===botId&&item.sourceSessionId).sort((a,b)=>b.createdAt-a.createdAt)
  const running=related.find(item=>item.status==='running'),task=running??related[0]
  const source=task?.sourceSessionId?getSession(task.sourceSessionId):session
  const receiverBotId=task?(task.requesterBotId??task.botId):botId
  const receiver=getBot(receiverBotId)
  if(!source||source.archived||!source.botIds.includes(receiverBotId)||!receiver||receiver.archived||isBotBeingRemoved(receiverBotId))throw new Error('The originating conversation is unavailable.')
  const user=[...session.messages].reverse().find(message=>message.role==='user'&&!message.internal)
  let original=running
  const visited=new Set<string>()
  while(original?.continuedFromTaskId){
    if(visited.has(original.id)){original=undefined;break}visited.add(original.id)
    const previous=tasks.find(item=>item.id===original!.continuedFromTaskId)
    if(!previous||previous.sessionId!==sessionId||previous.botId!==botId||previous.sourceSessionId!==source.id||(previous.requesterBotId??previous.botId)!==receiverBotId){original=undefined;break}
    original=previous
  }
  // Resuming the same task must not turn an uncertain/cancelled message into
  // a new automatic send merely because the continuation has a new task id.
  const scope=running?(original?`task:${original.id}`:undefined):!task&&!session.archived&&user?`message:${session.id}:${user.id}`:undefined
  return{source,receiverBotId,...(scope?{scope}:{})}
}
const fingerprint=(scope:string,sessionId:string,botId:string,account:string,input:DraftInput)=>createHash('sha256').update(JSON.stringify([scope,sessionId,botId,input.accountId??'default',account.toLowerCase(),input.to.toLowerCase(),input.subject,input.body])).digest('hex')

/** A new draft can send only under an exact user-saved rule. Existing drafts never auto-replay. */
export async function createGmailDraft(sessionId: string, botId: string, input: DraftInput, signal?:AbortSignal): Promise<GmailDraft> {
  const created=await serial(async () => {
    const {source,receiverBotId,scope}=requestContext(sessionId,botId)
    const accountId=input.accountId
    if(accountId!==undefined&&!/^g_[a-f0-9]{24}$/.test(accountId))throw new Error('Select a valid Gmail account.')
    const account = await readGoogleCredentials('gmail',accountId)
    if (!account) throw new Error('Gmail is not connected.')
    const to = typeof input.to === 'string' ? input.to.trim() : '', subject = typeof input.subject === 'string' ? input.subject.trim() : '', body = typeof input.body === 'string' ? input.body.trim() : ''
    if (!validMailAddress(to) || !subject || subject.length > 300 || /[\r\n\0]/.test(subject) || !body || body.length > 60_000) throw new Error('Provide one valid recipient, subject and body.')
    const records = await load(),requestFingerprint=scope?fingerprint(scope,source.id,botId,account.account,{to,subject,body,accountId}):undefined
    const sameContent=(d:GmailDraft)=>d.sessionId===source.id&&d.botId===botId&&d.accountId===accountId&&d.senderAccount.toLowerCase()===account.account.toLowerCase()&&d.to.toLowerCase()===to.toLowerCase()&&d.subject===subject&&d.body===body
    const existing = records.find((d) => d.sessionId === source.id && d.botId === botId && d.accountId===accountId&&d.senderAccount.toLowerCase() === account.account.toLowerCase() && ((requestFingerprint&&d.requestFingerprint===requestFingerprint)||(d.status==='draft'&&sameContent(d))))
    if (existing) return {draft:existing,fresh:false}
    const now = Date.now(), draft: GmailDraft = { id: randomUUID(), sessionId: source.id, botId, receiverBotId, senderAccount: account.account,...(accountId?{accountId}:{}), to, subject, body, status: 'draft', createdAt: now, updatedAt: now,...(scope?{requestScopeId:scope,requestFingerprint}:{}) }
    // A new local card is safe, but a rule cannot retry cancelled/uncertain
    // content, including after a later message. Legacy terminal records also
    // lack the request scope needed to prove that this is a distinct send.
    const needsNewConfirmation=records.some(d=>sameContent(d)&&((!d.requestScopeId&&d.status!=='draft')||['sending','uncertain','cancelled'].includes(d.status)))
    await save([...records, draft]); broadcast({ type: 'gmail-draft-updated', draft }); return {draft,fresh:!needsNewConfirmation}
  })
  // Retired automatic sending: a new message is always a review draft.
  // Explicit per-draft confirmation below retains ownership and stop checks.
  return created.draft
}
export async function listGmailDrafts(sessionId: string): Promise<GmailDraft[]> { return serial(async () => (await load()).filter((d) => d.sessionId === sessionId).map((d) => ({ ...d }))) }
export async function pendingGmailFeedback(): Promise<GmailDraft[]> { return serial(async () => (await load()).filter((d) => d.feedbackStatus === 'pending').map((d) => ({ ...d }))) }
export async function setGmailFeedback(id: string, from: GmailDraft['feedbackStatus'], to: GmailDraft['feedbackStatus']): Promise<GmailDraft | null> {
  return serial(async () => { const records = await load(), current = records.find((d) => d.id === id); if (!current || current.feedbackStatus !== from) return null; const next = { ...current, feedbackStatus: to }; await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'gmail-draft-updated', draft: next }); return next })
}

/** Only the trusted window can invoke manual send/cancel. A send rule uses its own durable claim. */
export async function actOnGmailDraft(id: string, sessionId: string, action: 'send' | 'cancel',beforeClaim?:(draft:GmailDraft)=>boolean,beforePost?:()=>boolean): Promise<GmailDraft> {
  const started = await serial(async () => {
    const records = await load(), current = records.find((d) => d.id === id && d.sessionId === sessionId)
    if (!current || current.status !== 'draft') throw new Error('This draft is no longer available.')
    if (action === 'send') {
      const account = await readGoogleCredentials('gmail',current.accountId); if (!account || account.account.toLowerCase() !== current.senderAccount.toLowerCase()) throw new Error('The Gmail account for this draft is not connected.')
      const source=getSession(current.sessionId),sender=getBot(current.botId),receiver=getBot(current.receiverBotId)
      if(!source||source.archived||source.mode!=='agent'||!source.botIds.includes(current.receiverBotId)||!sender||sender.archived||!receiver||receiver.archived||isBotBeingRemoved(current.botId)||isBotBeingRemoved(current.receiverBotId)||beforeClaim?.(current)===false)throw new Error('The originating conversation or authorization is no longer available.')
    }
    const next: GmailDraft = { ...current, status: action === 'send' ? 'sending' : 'cancelled',...(action==='send'?{sendNotStarted:undefined}:{}), ...(action === 'cancel' ? { feedbackStatus: 'pending' as const } : {}), updatedAt: Date.now() }
    await save(records.map((d) => d.id === id ? next : d)); broadcast({ type: 'gmail-draft-updated', draft: next }); return next
  })
  if (action === 'cancel') return started
  return finishSend(started,undefined,beforePost)
}

function originStillAvailable(draft:GmailDraft):boolean{
  const source=getSession(draft.sessionId),sender=getBot(draft.botId),receiver=getBot(draft.receiverBotId)
  return!!source&&!source.archived&&source.mode==='agent'&&source.botIds.includes(draft.receiverBotId)&&!!sender&&!sender.archived&&!!receiver&&!receiver.archived&&!isBotBeingRemoved(draft.botId)&&!isBotBeingRemoved(draft.receiverBotId)
}
async function finishSend(started:GmailDraft,signal?:AbortSignal,beforePost?:()=>boolean):Promise<GmailDraft>{
  let result: GmailDraft
  try { const guard=()=>{try{return!signal?.aborted&&originStillAvailable(started)&&beforePost?.()!==false}catch{return false}};result = { ...started, status: 'sent', feedbackStatus: 'pending', updatedAt: Date.now(), remoteId: await sendGmailRaw(gmailMime(started), started.senderAccount,started.accountId,guard) } }
  catch(error) {
    if(error instanceof GoogleSendNotStartedError){const {sendAuthorization:_authorization,...unsent}=started;result={...unsent,status:'draft',sendNotStarted:true,feedbackStatus:'pending',updatedAt:Date.now()}}
    else result = { ...started, status: 'uncertain', feedbackStatus: 'pending', updatedAt: Date.now() }
  }
  return serial(async () => {
    let next = result; const records = (await load()).map((d) => d.id === started.id ? next : d)
    try { await save(records) } catch { next = { ...started, status: 'uncertain', feedbackStatus: 'uncertain', updatedAt: Date.now() }; cached = records.map((d) => d.id === started.id ? next : d) }
    broadcast({ type: 'gmail-draft-updated', draft: next }); return next
  })
}
