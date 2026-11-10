import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import type { GmailSendRule } from '../../shared/sendRules'
import { broadcast } from '../agent/events'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { validMailAddress } from './gmailMime'

let override: SafeStorage | null | undefined
let queue: Promise<unknown> = Promise.resolve()
let knownRules=new Map<string,string>()
const ruleKey=(rule:GmailSendRule)=>JSON.stringify([rule.id,rule.service,rule.senderAccount,rule.accountId??'default',rule.to,rule.enabled,rule.revision,rule.updatedAt])
function adopt(rules:GmailSendRule[]):GmailSendRule[]{knownRules=new Map(rules.map(rule=>[rule.id,ruleKey(rule)]));return rules}
const file = () => join(dataRoot(), 'outbound-send-rules.json')
const address = (value: string) => value.trim().toLowerCase()
function serial<T>(work: () => Promise<T>): Promise<T> { const next=queue.then(work,work);queue=next.catch(()=>undefined);return next }
/** Test-only transport for synthetic data. Not exposed through any app API. */
export function setSendRuleStorageForTests(value: SafeStorage | null | undefined): void { override=value }
function storage(): SafeStorage {
  let api=override
  if(api===undefined){try{const e=createRequire(import.meta.url)('electron') as {safeStorage?:SafeStorage}|string;api=typeof e==='object'?e.safeStorage??null:null}catch{api=null}}
  if(!api?.isEncryptionAvailable())throw new Error('System encryption is unavailable for send rules.')
  return api
}
function parseRules(value: unknown): GmailSendRule[] {
  if(!Array.isArray(value)||value.some(rule=>!rule||typeof rule!=='object'||typeof rule.id!=='string'||!rule.id||rule.service!=='gmail'||typeof rule.senderAccount!=='string'||!validMailAddress(rule.senderAccount)||(rule.accountId!==undefined&&(typeof rule.accountId!=='string'||!/^g_[a-f0-9]{24}$/.test(rule.accountId)))||typeof rule.to!=='string'||!validMailAddress(rule.to)||typeof rule.enabled!=='boolean'||!Number.isSafeInteger(rule.revision)||rule.revision<1||!Number.isFinite(rule.createdAt)||!Number.isFinite(rule.updatedAt)))throw new Error('Send rule storage is invalid; no automatic send is allowed.')
  const ids=new Set<string>(),targets=new Set<string>()
  for(const rule of value){const target=JSON.stringify([rule.accountId??'default',address(rule.senderAccount),address(rule.to)]);if(ids.has(rule.id)||targets.has(target))throw new Error('Send rule storage is ambiguous.');ids.add(rule.id);targets.add(target)}
  return value as GmailSendRule[]
}
async function load(): Promise<GmailSendRule[]> {
  let raw:string
  try{raw=await readFile(file(),'utf8')}catch(error){adopt([]);if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw new Error('Send rules could not be read.')}
  let doc:unknown
  try{doc=JSON.parse(raw)}catch{adopt([]);throw new Error('Send rule storage is damaged; it was not changed.')}
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||(doc as {version?:unknown}).version!==1||typeof(doc as {encrypted?:unknown}).encrypted!=='string'){adopt([]);throw new Error('Send rule storage is invalid.')}
  try{return adopt(parseRules(JSON.parse(storage().decryptString(Buffer.from((doc as {encrypted:string}).encrypted,'base64')))))}catch{adopt([]);throw new Error('Send rules could not be unlocked or validated.')}
}
async function save(rules:GmailSendRule[]):Promise<void>{const encrypted=storage().encryptString(JSON.stringify(parseRules(rules))).toString('base64');await writeJsonNow(file(),{version:1,encrypted});adopt(rules)}
/** Synchronous deny-only check after token refresh; this never loads or grants a rule. */
export function sendRuleStillApplies(rule:GmailSendRule):boolean{return false // Retired automatic sending; existing encrypted records are retained.
}

export function listSendRules():Promise<GmailSendRule[]>{return serial(async()=>(await load()).map(rule=>({...rule})))}
/** Caller is the trusted draft IPC: neither account nor recipient comes from model rule arguments. */
export function saveGmailSendRule(senderAccount:string,to:string,accountId?:string):Promise<GmailSendRule>{return serial(async()=>{
  if(!validMailAddress(senderAccount)||!validMailAddress(to))throw new Error('One exact sender and recipient are required.')
  const rules=await load(),existing=rules.find(rule=>rule.accountId===accountId&&address(rule.senderAccount)===address(senderAccount)&&address(rule.to)===address(to))
  if(existing?.enabled)return{...existing}
  const now=Date.now(),rule:GmailSendRule={id:existing?.id??randomUUID(),service:'gmail',senderAccount:address(senderAccount),...(accountId?{accountId}:{}),to:address(to),enabled:true,revision:(existing?.revision??0)+1,createdAt:existing?.createdAt??now,updatedAt:now}
  await save([...rules.filter(r=>r.id!==rule.id),rule]);broadcast({type:'send-rules-updated'});return{...rule}
})}
export function removeSendRule(id:string):Promise<void>{return serial(async()=>{const rules=await load();if(!rules.some(rule=>rule.id===id))return;await save(rules.filter(rule=>rule.id!==id));broadcast({type:'send-rules-updated'})})}

/** Hold rule revocation through the short durable claim, never through a network request. */
export async function withMatchingGmailSendRule<T>(_senderAccount:string,_to:string,_claim:(rule:GmailSendRule)=>Promise<T>,_accountId?:string):Promise<T|undefined> {
  // No read/decryption and no claim. Explicit draft confirmation is handled separately.
  return undefined
}
