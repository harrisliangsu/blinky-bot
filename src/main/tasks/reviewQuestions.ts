import { getSession } from '../store/sessions'
import { getBot } from '../store/bots'
import { addNotice } from '../agent/messages'
/** A returned-task decision waits outside the Bot's model turn. */
import type { AgentTask, AgentTaskClarification, AgentTaskQuestion } from '../../shared/types'
import { getTask, listTasks } from '../store/tasks'
import { requestTaskClarification, listTaskClarifications } from './clarifications'
const active = new Map<string,{controller:AbortController;promise:Promise<void>;sourceSessionId:string}>()
export async function resolvedReviewQuestion(task: AgentTask): Promise<AgentTaskClarification | undefined> {
  if (task.review?.outcome !== 'blocked' || !task.sourceSessionId) return
  const requests = await listTaskClarifications(task.id)
  return requests.filter(request => request.reviewTaskId===task.id && request.botId===(task.requesterBotId??task.botId) &&
    request.sourceSessionId===task.sourceSessionId && (request.reviewRecordedAt===undefined || request.reviewRecordedAt===task.review!.recordedAt) && request.status==='answered' && request.answeredBy==='user' &&
    request.id!==task.review?.respondedTo && request.updatedAt>task.review!.recordedAt && !request.questions.some(question=>question.isSecret))
    .sort((a,b)=>b.updatedAt-a.updatedAt)[0]
}
export function queueReviewQuestion(task: AgentTask, onAnswer: () => Promise<void>, parentSignal?: AbortSignal): void {
  const previous=active.get(task.id)
  if(previous?.controller.signal.aborted)active.delete(task.id)
  if (active.has(task.id) || task.review?.outcome!=='blocked' || !task.review.question || !task.sourceSessionId) return
  if(parentSignal?.aborted)return
  const controller=new AbortController(),sourceSessionId=task.sourceSessionId
  const abort=()=>controller.abort();parentSignal?.addEventListener('abort',abort,{once:true})
  const promise=(async()=>{
    const current=getTask(task.id)
    if(!current || current.review?.recordedAt!==task.review?.recordedAt || listTasks().some(next=>next.continuedFromTaskId===task.id))return
    const reply=await requestTaskClarification(sourceSessionId,task.requesterBotId??task.botId,[task.review!.question as AgentTaskQuestion],controller.signal,
      `review:${task.id}:${task.review!.recordedAt}`,controller.signal,task.id,task.review!.recordedAt)
    if(reply&&!controller.signal.aborted)await onAnswer()
    else if(!controller.signal.aborted){
      const records=await listTaskClarifications(task.id).catch(()=>null)
      const shown=records?.find(request=>request.reviewRecordedAt===task.review!.recordedAt)
      if(!shown||shown.status==='failed'){
        const source=getSession(sourceSessionId)
        if(source)await addNotice(source,getBot(task.requesterBotId??task.botId),'待决定的问题暂未成功显示或取得回答，已有结果已保留，暂未确认任务完成。',undefined,`agent-review-question-unavailable-${task.id}-${task.review!.recordedAt}`)
      }
    }
  })().catch(()=>console.warn('[openbot/task-review] question unavailable',task.id)).finally(()=>{parentSignal?.removeEventListener('abort',abort);if(active.get(task.id)?.controller===controller)active.delete(task.id)})
  active.set(task.id,{controller,promise,sourceSessionId})
}
export function cancelReviewQuestions(taskId?: string, sourceSessionId?: string): void {
  for(const [id,entry] of active)if((!taskId||taskId===id)&&(!sourceSessionId||sourceSessionId===entry.sourceSessionId))entry.controller.abort()
}
