/** Slack credentials and routing are encrypted at rest and never returned to an Agent. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { dataRoot } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'

export interface SlackCredentials {
  appToken: string; botToken: string; teamId: string; botUserId: string; allowedUserId: string; channelId: string; botId: string
  /** User OAuth is outbound only. Existing records without this field remain Socket Mode. */
  oauth?: { clientId: string; scopes: string[]; refreshToken?: string; expiresAt?: number }
}
let override: SafeStorage | null | undefined
let queue: Promise<unknown> = Promise.resolve()
export function setSlackStorageForTests(value: SafeStorage | null | undefined): void { override = value }
function storage(): SafeStorage {
  let api=override
  if(api===undefined){try{const e=createRequire(import.meta.url)('electron') as {safeStorage?:SafeStorage}|string;api=typeof e==='object'?e.safeStorage??null:null}catch{api=null}}
  if(!api?.isEncryptionAvailable())throw new Error('System encryption is unavailable.')
  return api
}
function file():string{return join(dataRoot(),'slack-connection.json')}
function serial<T>(fn:()=>Promise<T>):Promise<T>{const next=queue.then(fn,fn);queue=next.catch(()=>undefined);return next}
function parse(raw:unknown):SlackCredentials {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid Slack connection.')
  const v=raw as Record<string,unknown>
  const oauth = v.oauth as SlackCredentials['oauth']
  const tokensValid = oauth
    ? v.appToken === '' && typeof v.botToken === 'string' && /^(?:xoxp-|xoxe\.xoxp-)[A-Za-z0-9-]{4,8192}$/.test(v.botToken) &&
      typeof oauth === 'object' && !Array.isArray(oauth) && /^\d{2,30}\.\d{2,30}$/.test(oauth.clientId) && Array.isArray(oauth.scopes) && oauth.scopes.every((x) => typeof x === 'string') &&
      (oauth.refreshToken === undefined || typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0 && oauth.refreshToken.length <= 8192) &&
      (oauth.expiresAt === undefined || typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) && typeof oauth.refreshToken === 'string')
    : typeof v.appToken === 'string' && /^xapp-[A-Za-z0-9-]{10,500}$/.test(v.appToken) && typeof v.botToken === 'string' && /^xoxb-[A-Za-z0-9-]{10,500}$/.test(v.botToken)
  if(!tokensValid||typeof v.teamId!=='string'||!/^T[A-Z0-9]{2,30}$/.test(v.teamId)||typeof v.botUserId!=='string'||!/^U[A-Z0-9]{2,30}$/.test(v.botUserId)||typeof v.allowedUserId!=='string'||!/^[UW][A-Z0-9]{2,30}$/.test(v.allowedUserId)||typeof v.channelId!=='string'||!/^[CGD][A-Z0-9]{2,30}$/.test(v.channelId)||typeof v.botId!=='string'||!v.botId||v.botId.length>200)throw new Error('Invalid Slack connection.')
  return v as unknown as SlackCredentials
}
async function document():Promise<{version:1;ciphertext:string}|null>{
  let raw:string;try{raw=await readFile(file(),'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Slack connection could not be read.')}
  let value:unknown;try{value=JSON.parse(raw)}catch{throw new Error('Slack connection storage is damaged; it was not changed.')}
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as Record<string,unknown>).version!==1||typeof(value as Record<string,unknown>).ciphertext!=='string')throw new Error('Slack connection storage is invalid; it was not changed.')
  return value as {version:1;ciphertext:string}
}
export function assertSlackStorageAvailable():void{storage()}
export async function readSlackCredentials():Promise<SlackCredentials|null>{await queue;const doc=await document();if(!doc||!doc.ciphertext)return null;try{return parse(JSON.parse(storage().decryptString(Buffer.from(doc.ciphertext,'base64'))))}catch{throw new Error('Slack connection could not be unlocked.')}}
export function saveSlackCredentials(value:SlackCredentials, stillCurrent: () => boolean = () => true):Promise<void>{return serial(async()=>{const clean=parse(value);await document();if(!stillCurrent())throw new Error('Slack authorization changed.');await writeJsonNow(file(),{version:1,ciphertext:storage().encryptString(JSON.stringify(clean)).toString('base64')})})}
/** An empty encrypted record revokes local use without modifying Slack itself. */
export function clearSlackCredentials():Promise<void>{return serial(async()=>{await document();await writeJsonNow(file(),{version:1,ciphertext:''})})}
