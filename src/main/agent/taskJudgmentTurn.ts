/** Use the owning Bot's NORMAL turn/identity/approval chain, never an ungoverned side-call. */
import type { Bot } from '../../shared/types'
import * as cancel from './cancel'
import * as approval from './approval'
import * as limits from './limits'
import { sessions } from './sessionGateway'
import { getBot, applyBotBinding } from '../store/bots'
import { getTask } from '../store/tasks'
import { getSettings } from '../settings'
import { getMessageQueue } from '../store/messageQueue'
import { flushAll } from '../store/jsonStore'
import { addUserMessage } from './messages'
import { broadcast } from './events'
import { runSupervisedTurn } from './supervisedTurn'
import { runTurn } from './turn'
import { modeFor } from './backendMode'
import { getBackendInfo } from './backendGateway'
import { cancelGatewayDetach, detachGateway } from './mcpGateway'
import { beginTaskJudgment, taskJudgmentScope, taskJudgmentInterruption } from './taskJudgmentScope'
import { localExecutionPolicy } from '../../shared/localExecution'
import { clearPendingNote } from './handoff'
import { clearReplyHistory } from './replyHistory'
import { stopWarmCodexForSession } from '../backends/cli/codexAppServer'
import { emitTelemetry } from '../telemetry'
import { discardEphemeralBindingsForSession, flushProviderBindings } from '../store/providerBindings'

export interface TaskJudgmentResult { state: 'ready' | 'deferred' | 'denied' | 'permission-required' | 'failed'; text?: string }
export async function runTaskJudgmentTurn(input: { sessionId: string; botId: string; taskId: string; requestId: string; prompt: string; signal: AbortSignal }): Promise<TaskJudgmentResult> {
  // Reserve synchronously; human messages and another task must never share a CLI turn.
  const queue=getMessageQueue(input.sessionId)
  if (input.signal.aborted || cancel.isRunning(input.sessionId) || queue.paused || queue.items.length) return {state:'deferred'}
  const controller = cancel.start(input.sessionId)
  const signal = AbortSignal.any([controller.signal, input.signal])
  const release = beginTaskJudgment(input.sessionId,input.taskId,input.botId,input.requestId,input.prompt)
  const scope = taskJudgmentScope(input.sessionId)!
  let session: Awaited<ReturnType<typeof sessions.get>> = null
  cancelGatewayDetach(input.sessionId)
  try {
    session = await sessions.get(input.sessionId)
    const task=getTask(input.taskId), source=getBot(input.botId)
    if (!session || session.archived || session.mode!=='agent' || !source || source.archived || !session.botIds.includes(input.botId) || task?.sourceSessionId!==session.id || (task.requesterBotId??task.botId)!==input.botId) return {state:'deferred'}
    const bot: Bot=applyBotBinding(source), settings=getSettings()
    broadcast({type:'run-started',sessionId:session.id})
    // The full current envelope is supplied from the temporary scope in runTurn.
    // Do not duplicate task/user history into the permanent main chat on every
    // check; source records and the per-task input hash already retain its basis.
    await addUserMessage(session,`Internal task consideration: ${input.taskId}`,undefined,false,`agent-judgment-${input.requestId}`,undefined,true)
    const saved=await flushAll()
    if(saved.failed.length||saved.stillWriting) return {state:'failed'}
    cancel.markRecorded(session.id,controller); limits.resetTurn(session.id);clearPendingNote(session.id);clearReplyHistory(session.id)
    if(signal.aborted) return {state:'deferred'}
    const mode=modeFor(await getBackendInfo(bot.backendId),bot.computerTarget)
    const current=getBot(input.botId)
    if(!current||JSON.stringify(applyBotBinding(current))!==JSON.stringify(bot))return {state:'deferred'}
    if(mode==='supervised'&&bot.computerTarget?.kind==='vm')return {state:'failed'}
    if(mode==='orchestrated'&&!limits.takeIteration(session.id))return {state:'failed'}
    if(mode==='supervised'&&localExecutionPolicy(getSettings())==='never-allow')return {state:'denied'}
    const args={session,bot,settings:getSettings(),signal,extras:[],replyTo:null,floor:null,retry:false,internalAssistant:true}
    let result=mode==='supervised' ? await runSupervisedTurn(args) : await runTurn(args)
    while(result.status==='tools'&&!signal.aborted&&!scope.attemptedTool&&!getMessageQueue(session.id).items.length&&limits.takeIteration(session.id))result=await runTurn({...args,settings:getSettings()})
    const rejection=cancel.rejectedApprovalFor(session.id,controller)
    if(rejection){await addUserMessage(session,rejection,undefined,false,undefined,undefined,true);await flushAll();return {state:'denied'}}
    // The source may have accepted a human follow-up while this hidden turn ran.
    const interrupted=taskJudgmentInterruption(scope,signal.aborted,getMessageQueue(session.id).items.length>0)
    if(interrupted)return {state:interrupted}
    if(result.status!=='final'||result.message.error||scope.errors.length||scope.attemptedTool) { emitTelemetry({ kind: 'judgment.turn_failed', taskId: input.taskId, outcome: 'failed', detail: JSON.stringify({ status: result.status, error: result.message.error ?? null, scopeErrors: scope.errors.length, attemptedTool: scope.attemptedTool }) }); return {state:'failed'} }
    const persisted=await flushAll()
    if(persisted.failed.length||persisted.stillWriting) return {state:'failed'}
    return {state:'ready',text:result.message.displayContent??result.message.content}
  } catch { emitTelemetry({ kind: 'judgment.turn_failed', taskId: input.taskId, outcome: signal.aborted ? 'deferred' : 'failed' }); return {state:signal.aborted?'deferred':'failed'} }
  finally {
    approval.cancelPending(input.sessionId,'internal judgment ended')
    try{
      // No delayed MCP/native thread may outlive the narrower turn scope.
      if(scope.nativeSessionId)stopWarmCodexForSession(scope.nativeSessionId)
      await detachGateway(input.sessionId)
      if(scope.nativeSessionId){discardEphemeralBindingsForSession(scope.nativeSessionId);await flushProviderBindings()}
    }finally{
      cancel.finish(input.sessionId,controller)
      if(session) broadcast({type:'session-updated',session})
      // Queue draining still sees done; generic reply notifications do not.
      broadcast({type:'done',sessionId:input.sessionId})
      release()
    }
  }
}
