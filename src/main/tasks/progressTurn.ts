/** Durable consideration receipts. They do not start/resume an execution Agent. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { runTaskJudgmentTurn } from '../agent/taskJudgmentTurn'
import { parseProgressDecision } from './progressDecisionPolicy'
import type { ProgressDecision, ProgressSnapshot } from './progressMonitor'
import type { Settings } from '../../shared/types'

interface ProgressTurnState {
  version: 1; owner: string; input: string; permissions: string; attempt: string
  state: 'prepared'|'ready'|'deferred'|'denied'|'permission-required'|'failed'|'uncertain'
  updatedAt: number; retryAt?: number; failures?: number; decision?: ProgressDecision
}
const inFlight=new Map<string,Promise<ProgressDecision|null>>()
const file=(id:string)=>join(dataRoot(),'task-judgments',`${safeFileName(id)}.json`)
export async function taskJudgmentStatus(id:string):Promise<Record<string,unknown>|null> {
  const read=await readJsonState<ProgressTurnState|null>(file(id),null)
  if(read.status==='missing')return null
  const s=read.value
  if(read.status!=='ok'||!s||s.version!==1||typeof s.owner!=='string'||typeof s.input!=='string'||typeof s.permissions!=='string'||!['prepared','ready','deferred','denied','permission-required','failed','uncertain'].includes(s.state))return {state:'unavailable'}
  return s as unknown as Record<string,unknown>
}
export function progressPermissionRevision(settings:Settings):string {
  return createHash('sha256').update(JSON.stringify([settings.localExecutionPolicy,settings.approvalPolicy,settings.automaticReview,settings.allowlist,settings.denylist,settings.asklist,settings.semanticPermissionRules])).digest('hex')
}
export async function protectedProgressDecision(s:ProgressSnapshot, input:{sessionId:string;botId:string;prompt:string;permissions:string;signal:AbortSignal}):Promise<ProgressDecision|null> {
  const key=createHash('sha256').update(input.prompt).digest('hex')
  const active=inFlight.get(s.id)
  if(active){await active;if(inFlight.get(s.id)===active)inFlight.delete(s.id);return protectedProgressDecision(s,input)}
  const operation=consider(s,input,key)
  inFlight.set(s.id,operation)
  try{return await operation}finally{if(inFlight.get(s.id)===operation)inFlight.delete(s.id)}
}
async function consider(s:ProgressSnapshot,input:{sessionId:string;botId:string;prompt:string;permissions:string;signal:AbortSignal},key:string):Promise<ProgressDecision|null> {
  if(input.signal.aborted)return null
  const old=await taskJudgmentStatus(s.id) as ProgressTurnState|null
  if(old&&(!old.owner||old.owner!==s.owner))return null
  // A user denial blocks ALL automatic considerations for this task until
  // they explicitly change permission settings. A new report is not consent.
  if(old&&['denied','permission-required'].includes(old.state)&&old.permissions===input.permissions)return null
  if(old?.input===key&&old.permissions===input.permissions){
    if(old.state==='ready')return old.decision??null
    if(old.state==='prepared') {await writeJsonNow(file(s.id),{...old,state:'uncertain',updatedAt:Date.now()});return null}
    if(old.state==='uncertain'||(old.retryAt??0)>Date.now())return null
  }
  const state:ProgressTurnState={version:1,owner:s.owner,input:key,permissions:input.permissions,attempt:randomUUID(),state:'prepared',updatedAt:Date.now(),failures:old?.failures??0}
  await writeJsonNow(file(s.id),state)
  const result=await runTaskJudgmentTurn({...input,taskId:s.id,requestId:state.attempt})
  const decision=result.state==='ready'&&result.text?parseProgressDecision(result.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'),s):null
  state.updatedAt=Date.now()
  if(decision){state.state='ready';state.decision=decision;state.failures=0}
  else {
    state.state=result.state==='ready'?'failed':result.state
    state.failures=(state.failures??0)+(state.state==='failed'?1:0)
    if(!['denied','permission-required'].includes(state.state))state.retryAt=Date.now()+(state.state==='deferred'?5_000:Math.min(10,2**Math.min(4,state.failures??0))*60_000)
  }
  await writeJsonNow(file(s.id),state)
  return decision
}
