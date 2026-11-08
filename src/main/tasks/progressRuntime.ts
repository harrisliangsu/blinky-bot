/** Events first, bounded compensation second; owned by the host. */
import { join } from 'node:path'
import { onAgentEvent } from '../agent/events'
import { addNotice } from '../agent/messages'
import { sessions } from '../agent/sessionGateway'
import { getBot } from '../store/bots'
import { getTask, listTasks } from '../store/tasks'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow, flushAll } from '../store/jsonStore'
import { TaskProgressMonitor, PROGRESS_SCAN_MS, progressKey, type ProgressState, type ProgressSnapshot, type ProgressDecision } from './progressMonitor'
import { observeProgressEvent, progressSnapshot } from './progressObservations'
import { TaskCoordinator, type CoordinationState } from './coordination'
import { manageBackgroundTask } from '../tasks'
import { taskMessages } from './messages'
import { showDesktopNotification } from '../desktopNotifications'
import { routineOwnsNotifications } from '../routines/notificationOwnership'
import { judgeTaskProgress } from './progressDecision'
import { toolAllowedForBot } from '../agent/execute'
import { authorizeCoordination } from './coordinationPermission'
let stop: (() => void) | undefined
export function installTaskProgressMonitor(): void {
  if (stop) return
  let closed = false
  const controller = new AbortController()
  const snapshotFor = async (task: NonNullable<ReturnType<typeof getTask>>) => progressSnapshot(task, await taskMessages(task.id))
  const path = (id: string) => join(dataRoot(), 'task-progress', `${safeFileName(id)}.json`)
  const readCoordination = async (id:string):Promise<CoordinationState|null> => {
      const result = await readJsonState<CoordinationState | null>(join(dataRoot(),'task-coordination',`${safeFileName(id)}.json`),null)
      if (result.status === 'missing') return null
      if (result.status !== 'ok' || !result.value || result.value.version !== 1 || typeof result.value.owner !== 'string' || !Number.isFinite(result.value.sequence) || !Number.isFinite(result.value.nextCheckAt)) throw Error('Unreadable coordination record')
      return result.value
  }
  const judgments=new Map<string,{key:string;promise:Promise<ProgressDecision|null>}>()
  const decisionFor=async(s:ProgressSnapshot):Promise<ProgressDecision|null>=>{
    // A corrupt communication ledger still blocks sends in the coordinator;
    // it must not suppress a separately observed task failure or permission card.
    const receipts=await taskMessages(s.id).catch(()=>[]), readState=await readCoordination(s.id).catch(()=>null)
    const state=readState?.owner===s.owner?readState:null
    const task=getTask(s.id), execution=task&&await sessions.get(task.sessionId)
    const reports=receipts.filter(r=>r.direction==='to_lead'&&r.status==='delivered').map(r=>({id:r.requestId,at:r.updatedAt}))
    const responses=receipts.filter(r=>r.direction==='to_executor'&&r.status==='delivered'&&r.responseMessageIds?.length).map(r=>({id:`reply:${r.requestId}`,at:r.updatedAt}))
    const conversation=(execution?.messages??[]).filter(m=>m.role==='assistant'&&!m.streaming&&!m.uiOnly&&!m.internal).slice(-1).map(m=>({id:`message:${m.id}`,at:m.createdAt}))
    const replies=new Set([...reports,...responses].map(r=>r.id))
    const context={due:s.phase==='running'&&Boolean(state&&Date.now()>=state.nextCheckAt),awaitingReply:state?.awaitingReply&&!replies.has(`reply:${state.awaitingReply}`)?state.awaitingReply:undefined,
      // The latest observation is stable before/after coordinator consumption;
      // consumed-event bookkeeping is not a second semantic question for the Bot.
      newReport:[...reports,...responses,...conversation].sort((a,b)=>a.at-b.at).at(-1)?.id,
      previousMessages:receipts.filter(r=>r.direction==='to_executor'&&r.requestId.startsWith('bot-coordinate:')).slice(-8).map(r=>({id:r.requestId,text:r.text,delivery:r.status,responded:Boolean(r.responseMessageIds?.length)||replies.has(`reply:${r.requestId}`)}))}
    const key=JSON.stringify([s,context]), pending=judgments.get(s.id)
    if(pending?.key===key)return pending.promise
    const promise=judgeTaskProgress(s,controller.signal,context)
    const record={key,promise};judgments.set(s.id,record)
    try{return await promise}finally{if(judgments.get(s.id)===record)judgments.delete(s.id)}
  }
  const coordinator = new TaskCoordinator({
    now: Date.now,
    read: readCoordination,
    write: (id,value) => writeJsonNow(join(dataRoot(),'task-coordination',`${safeFileName(id)}.json`),value),
    decide: async s => {
      const decision=await decisionFor(s); return decision ? decision.coordination ?? {kind:'wait',text:''} : null
    },
    send: async (s,requestId,text,kind) => {
      const task = getTask(s.id), fresh = task && await snapshotFor(task)
      if (closed || !task?.sourceSessionId || !fresh || fresh.owner !== s.owner || !['running','waiting_user','waiting_help','reconnecting'].includes(fresh.phase)) throw Error('Coordination target changed')
      const owner=getBot(task.requesterBotId??task.botId)
      if(!owner||!await toolAllowedForBot(owner,'manage_task'))return 'not-permitted'
      const source=await sessions.get(task.sourceSessionId)
      const lastUser=source?.messages.filter(m=>m.role==='user'&&!m.internal&&!m.uiOnly).at(-1)?.id
      const valid=async()=>{
        const current=getTask(s.id), currentOwner=getBot(owner.id), currentSource=await sessions.get(task.sourceSessionId!)
        const observation=current&&await snapshotFor(current)
        return !closed&&Boolean(currentOwner&&!currentOwner.archived&&await toolAllowedForBot(currentOwner,'manage_task')&&
          currentSource&&!currentSource.archived&&currentSource.mode==='agent'&&currentSource.botIds.includes(owner.id)&&
          currentSource.messages.filter(m=>m.role==='user'&&!m.internal&&!m.uiOnly).at(-1)?.id===lastUser&&
          observation&&observation.owner===s.owner&&progressKey(observation)===progressKey(s)&&
          ['running','waiting_user','waiting_help','reconnecting'].includes(observation.phase))
      }
      const authorization=await authorizeCoordination({taskId:s.id,owner:s.owner,sessionId:task.sourceSessionId,botId:owner.id,requestId,text,kind,signal:controller.signal,valid})
      if(authorization!=='approved')return authorization
      const result = await manageBackgroundTask(task.sourceSessionId,task.requesterBotId ?? task.botId,{action:'message',taskId:task.id,requestId,text},controller.signal,undefined,kind==='ask'?'turn_boundary':undefined) as {receipt?:{status?:string}}
      return result.receipt?.status ?? 'uncertain'
    },
    error: id => console.warn('[openbot/task-coordination] unavailable',id)
  })
  const coordinate = async () => {
    if (closed) return
    await Promise.all(listTasks().filter(t=>t.status==='running'||['pending','delivering','uncertain'].includes(t.deliveryStatus??'')).map(async task=>{
      try {
        const receipts=await taskMessages(task.id), s=progressSnapshot(task,receipts)
        const reports=receipts.filter(r=>r.direction==='to_lead'&&r.status==='delivered').map(r=>({id:r.requestId,at:r.updatedAt}))
        const execution=await sessions.get(task.sessionId)
        const conversationReports=(execution?.messages??[]).filter(m=>m.role==='assistant'&&!m.streaming&&!m.uiOnly&&!m.internal).slice(-1).map(m=>({id:`message:${m.id}`,at:m.createdAt}))
        const responses=receipts.filter(r=>r.direction==='to_executor'&&r.status==='delivered'&&r.responseMessageIds?.length).map(r=>({id:`reply:${r.requestId}`,at:r.updatedAt}))
        const answered=[...reports,...responses,...conversationReports].sort((a,b)=>a.at-b.at)
        if (s) await coordinator.observe({snapshot:s,report:answered.at(-1)?.id,deliveries:Object.fromEntries(receipts.map(r=>[r.requestId,r.status])),replies:[...reports,...responses].map(r=>r.id)})
      } catch { console.warn('[openbot/task-coordination] observation unavailable',task.id) }
    }))
  }
  const monitor = new TaskProgressMonitor({
    snapshots: async () => {
      const tasks = closed ? [] : listTasks().filter(t => ['queued', 'running'].includes(t.status) || ['pending', 'uncertain', 'delivering'].includes(t.deliveryStatus ?? ''))
      const rows = await Promise.all(tasks.map(async task => { try { return await snapshotFor(task) } catch { return progressSnapshot(task) } }))
      return rows.flatMap(s => s ? [s] : [])
    },
    read: async id => {
      const read = await readJsonState<Record<string, unknown> | null>(path(id), null)
      if (read.status === 'missing') return null
      const v = read.value
      if (read.status !== 'ok' || !v || ![1, 2].includes(Number(v.version)) || typeof v.owner !== 'string' || typeof v.phase !== 'string' || typeof v.progress !== 'string' || !Number.isFinite(v.sequence)) throw new Error('Progress record is unreadable; delivery was not assumed.')
      // Legacy quiet/todo notices are not a user update and must never replay.
      if (v.version === 1) return { version: 2, owner: v.owner, phase: v.phase as ProgressState['phase'], progress: v.progress, sequence: Number(v.sequence) }
      if (v.pending && (typeof v.pending !== 'object' || typeof (v.pending as Record<string, unknown>).id !== 'string' || typeof (v.pending as Record<string, unknown>).snapshot !== 'string' || typeof (v.pending as Record<string, unknown>).text !== 'string')) throw new Error('Invalid progress outbox.')
      return v as unknown as ProgressState
    },
    judge: decisionFor,
    write: (id, state) => writeJsonNow(path(id), state),
    post: async (s, notice) => {
      const task = getTask(s.id), fresh = task && await snapshotFor(task)
      if (closed || !task?.sourceSessionId || !fresh || progressKey(fresh) !== notice.snapshot) return false
      const source = await sessions.get(task.sourceSessionId)
      const latest = getTask(s.id), check = latest && await snapshotFor(latest)
      if (closed || !source || !check || progressKey(check) !== notice.snapshot) return false
      const appended = !source.messages.some(m => m.id === notice.id)
      if (appended) await addNotice(source, getBot(task.requesterBotId ?? task.botId), notice.text, undefined, notice.id)
      const flushed = await flushAll()
      if (flushed.failed.length || flushed.stillWriting || !(await sessions.get(source.id))?.messages.some(m => m.id === notice.id)) throw new Error('Progress notice was not confirmed saved.')
      if (appended && s.terminal && !routineOwnsNotifications(source.id)) showDesktopNotification(s.phase === 'completed' ? 'task-returned' : 'failed', { sessionId: source.id, botId: task.requesterBotId ?? task.botId }, false, notice.id)
      return true
    },
    error: (id, _error) => {
      console.warn('[openbot/task-progress] observation or delivery unavailable', id)
      // A monitor fault is diagnostic, not permission to bypass the owning Bot.
      // The task/error/permission UI remains available; unchanged scans retry.

    }
  })
  let debounce: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (debounce) return
    debounce = setTimeout(() => { debounce = undefined; void monitor.scan().catch(() => console.warn('[openbot/task-progress] scan unavailable')); void coordinate() }, 500)
    debounce.unref?.()
  }
  const unsubscribe = onAgentEvent(e => {
    observeProgressEvent(e)
    // Deltas restore transport liveness without producing notices or disk IO.
    if (['task-updated', 'message-end', 'session-updated', 'todos', 'approval-request', 'approval-resolved', 'human-help-request', 'human-help-resolved', 'task-clarification-updated', 'backend-notice', 'done'].includes(e.type)) schedule()
  })
  const interval = setInterval(schedule, PROGRESS_SCAN_MS); interval.unref?.()
  stop = () => { closed = true; controller.abort(); unsubscribe(); clearInterval(interval); if (debounce) clearTimeout(debounce); stop = undefined }
  schedule()
}
export function stopTaskProgressMonitor(): void { stop?.() }
