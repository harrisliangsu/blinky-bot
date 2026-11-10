/** Narrower application capability scope for a normal, permission-governed Bot turn. */
export interface TaskJudgmentScope { taskId: string; botId: string; errors: string[]; attemptedTool: boolean; denied: boolean; permissionUnconfirmed: boolean; prompt?:string; nativeSessionId?:string; inputMessageId?:string }
const active = new Map<string, TaskJudgmentScope>()
/** Keep other internal records, such as rejected approvals and task results. */
export function withoutTaskJudgmentDrafts<T extends {id:string}>(messages:T[]):T[]{return messages.filter(m=>!m.id.startsWith('agent-judgment-'))}
export function currentTaskJudgmentMessages<T extends {id:string}>(sessionId:string,messages:T[]):T[]{
  const start=active.get(sessionId)?.inputMessageId
  const at=start?messages.findIndex(m=>m.id===start):-1
  return at<0?[]:messages.slice(at+1)
}
export const taskJudgmentScope = (sessionId: string): TaskJudgmentScope | undefined => active.get(sessionId)
/** A queued human follow-up is not a refused/unanswered automatic permission. */
export function taskJudgmentInterruption(scope:Pick<TaskJudgmentScope,'denied'|'permissionUnconfirmed'>,aborted:boolean,queuedHuman:boolean):'denied'|'permission-required'|'deferred'|undefined{
  if(scope.denied)return 'denied'
  if(queuedHuman)return 'deferred'
  if(scope.permissionUnconfirmed)return 'permission-required'
  if(aborted)return 'deferred'
  return undefined
}
/** Tool-level mutating:false is not an action-level permission contract. */
export function taskJudgmentAllows(sessionId:string,name:string,args:Record<string,unknown>):boolean {
  const scope=active.get(sessionId)
  if(!scope)return true
  if(name!=='manage_task')return false
  if(args.action==='inspect')return args.task_id===scope.taskId
  // Normal Bot/source ACLs, schema and pagination still run in the tool.
  // match is recognized for safe integration; it is not implemented here.
  return args.action==='list'||args.action==='match'
}
export function beginTaskJudgment(sessionId: string, taskId: string, botId: string, requestId?:string, prompt?:string): () => void {
  if (active.has(sessionId)) throw new Error('The owning Bot is already considering task progress')
  const scope: TaskJudgmentScope = { taskId, botId, errors: [], attemptedTool: false, denied: false, permissionUnconfirmed: false }
  if(requestId){scope.nativeSessionId=`${sessionId}:task-judgment:${requestId}`;scope.prompt=prompt;scope.inputMessageId=`agent-judgment-${requestId}`}
  active.set(sessionId, scope)
  return () => { if (active.get(sessionId) === scope) active.delete(sessionId) }
}
