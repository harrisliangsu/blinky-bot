import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SlackDraft } from '../../shared/drafts'
import { broadcast } from '../agent/events'
import { getBot } from '../store/bots'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { postSlackMessage } from './slackApi'
import { readSlackCredentials } from './slackSecrets'

let cached: SlackDraft[] | undefined, queue: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'slack-drafts.json')
function serial<T>(fn:()=>Promise<T>):Promise<T>{const next=queue.then(fn,fn);queue=next.catch(()=>undefined);return next}
function validDraft(raw: unknown): raw is SlackDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const d = raw as Record<string, unknown>
  return typeof d.id === 'string' && d.id.length > 0 && typeof d.sessionId === 'string' && !!d.sessionId && typeof d.botId === 'string' && !!d.botId && typeof d.receiverBotId === 'string' && !!d.receiverBotId &&
    typeof d.teamId === 'string' && /^T[A-Z0-9]{2,30}$/.test(d.teamId) && typeof d.slackBotUserId === 'string' && /^U[A-Z0-9]{2,30}$/.test(d.slackBotUserId) && typeof d.channelId === 'string' && /^[CGD][A-Z0-9]{2,30}$/.test(d.channelId) &&
    typeof d.text === 'string' && !!d.text.trim() && d.text.length <= 40_000 && (d.threadTs === undefined || typeof d.threadTs === 'string' && /^\d+\.\d+$/.test(d.threadTs)) &&
    typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) && typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) &&
    ['draft','sending','sent','uncertain','cancelled'].includes(String(d.status)) && (d.feedbackStatus === undefined || ['pending','delivering','delivered','uncertain'].includes(String(d.feedbackStatus))) &&
    (d.remoteTs === undefined || typeof d.remoteTs === 'string' && /^\d+\.\d+$/.test(d.remoteTs))
}
async function load():Promise<SlackDraft[]> {
  if(cached)return cached
  let raw:string;try{raw=await readFile(file(),'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return(cached=[]);throw new Error('Slack drafts could not be read.')}
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{throw new Error('Slack draft storage is damaged; it was not changed.')}
  if(!Array.isArray(parsed)||!parsed.every(validDraft))throw new Error('Slack draft storage is invalid; it was not changed.')
  const records=parsed as SlackDraft[]
  if(records.some((d)=>d.status==='sending'||d.feedbackStatus==='delivering')){const recovered=records.map((d)=>({...d,...(d.status==='sending'?{status:'uncertain' as const,feedbackStatus:'pending' as const,updatedAt:Date.now()}:{}),...(d.feedbackStatus==='delivering'?{feedbackStatus:'uncertain' as const}:{})}));await writeJsonNow(file(),recovered);return(cached=recovered)}
  return(cached=records)
}
async function save(records:SlackDraft[]):Promise<void>{await writeJsonNow(file(),records);cached=records}
export async function createSlackDraft(sessionId:string,botId:string,input:{text:string;threadTs?:string}):Promise<SlackDraft>{
  return serial(async()=>{
    const session=getSession(sessionId);if(!session||!session.botIds.includes(botId)||!getBot(botId))throw new Error('This Bot does not belong to this conversation.')
    const task=listTasks().find((item)=>item.sessionId===sessionId&&item.botId===botId&&item.sourceSessionId),source=task?.sourceSessionId?getSession(task.sourceSessionId):session
    if(!source||source.archived)throw new Error('The originating conversation is unavailable.')
    const config=await readSlackCredentials();if(!config||config.botId!==(task?.requesterBotId??task?.botId??botId))throw new Error('Slack is not connected for this Bot.')
    const text=typeof input.text==='string'?input.text.trim():'',threadTs=input.threadTs?.trim()
    if(!text||text.length>40_000||(threadTs!==undefined&&!/^\d+\.\d+$/.test(threadTs)))throw new Error('Provide a message and a valid thread timestamp.')
    const records=await load(),receiverBotId=task?(task.requesterBotId??task.botId):botId
    const existing=records.find((d)=>d.sessionId===source.id&&d.botId===botId&&d.teamId===config.teamId&&d.channelId===config.channelId&&d.status==='draft'&&d.text===text&&d.threadTs===threadTs)
    if(existing)return existing
    const now=Date.now(),draft:SlackDraft={id:randomUUID(),sessionId:source.id,botId,receiverBotId,teamId:config.teamId,slackBotUserId:config.botUserId,channelId:config.channelId,...(threadTs?{threadTs}:{}),text,status:'draft',createdAt:now,updatedAt:now}
    await save([...records,draft]);broadcast({type:'slack-draft-updated',draft});return draft
  })
}
export async function listSlackDrafts(sessionId:string):Promise<SlackDraft[]>{return serial(async()=>(await load()).filter((d)=>d.sessionId===sessionId).map((d)=>({...d})))}
export async function pendingSlackFeedback():Promise<SlackDraft[]>{return serial(async()=>(await load()).filter((d)=>d.feedbackStatus==='pending').map((d)=>({...d})))}
export async function setSlackFeedback(id:string,from:SlackDraft['feedbackStatus'],to:SlackDraft['feedbackStatus']):Promise<SlackDraft|null>{return serial(async()=>{const all=await load(),d=all.find((v)=>v.id===id);if(!d||d.feedbackStatus!==from)return null;const next={...d,feedbackStatus:to};await save(all.map((v)=>v.id===id?next:v));broadcast({type:'slack-draft-updated',draft:next});return next})}
export async function actOnSlackDraft(id:string,sessionId:string,action:'send'|'cancel'):Promise<SlackDraft>{
  const started=await serial(async()=>{const all=await load(),d=all.find((v)=>v.id===id&&v.sessionId===sessionId);if(!d||d.status!=='draft')throw new Error('This draft is no longer available.')
    if(action==='send'){const c=await readSlackCredentials();if(!c||c.teamId!==d.teamId||c.channelId!==d.channelId||c.botUserId!==d.slackBotUserId)throw new Error('The Slack connection for this draft changed.')}
    const next:SlackDraft={...d,status:action==='send'?'sending':'cancelled',...(action==='cancel'?{feedbackStatus:'pending' as const}:{}),updatedAt:Date.now()};await save(all.map((v)=>v.id===id?next:v));broadcast({type:'slack-draft-updated',draft:next});return next})
  if(action==='cancel')return started
  let result:SlackDraft
  try{const sent=await postSlackMessage({teamId:started.teamId,botUserId:started.slackBotUserId,channelId:started.channelId},started.text,started.threadTs);result={...started,status:'sent',feedbackStatus:'pending',remoteTs:sent.ts,updatedAt:Date.now()}}
  catch{result={...started,status:'uncertain',feedbackStatus:'pending',updatedAt:Date.now()}}
  return serial(async()=>{let next=result;const all=(await load()).map((d)=>d.id===id?next:d);try{await save(all)}catch{next={...started,status:'uncertain',feedbackStatus:'uncertain',updatedAt:Date.now()};cached=all.map((d)=>d.id===id?next:d)}broadcast({type:'slack-draft-updated',draft:next});return next})
}
