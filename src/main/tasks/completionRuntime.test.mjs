/** Real queue + loop + turnDriver + stores. The executor and all desktop APIs are inert. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const mocks={
  './tasks/progressTurn':`export const taskJudgmentStatus=async()=>null`,
  './tasks/coordinationPermission':`export const communicationPermissionStatus=async()=>null`,
  electron:`export class BrowserWindow{constructor(){throw Error('Window creation forbidden')}static getAllWindows(){return []}static getFocusedWindow(){return null}}export class Notification{static isSupported(){return false}constructor(){throw Error('Native notification forbidden')}}export const app={getPath(){throw Error('Formal data fallback forbidden')}};export const safeStorage={isEncryptionAvailable:()=>false,encryptString(){throw Error('Credentials forbidden')},decryptString(){throw Error('Credentials forbidden')}}`,
  './backendGateway':`export const getBackendInfo=async()=>{await globalThis.__completionLoop.beforeBackend?.();return {kind:'api'}};export const getBackend=async()=>{throw Error('Hidden backend discovery forbidden')};export const runSideCall=async()=>{throw Error('Model side calls forbidden')}`,
  '../agent/backendGateway':`export const getBackend=async()=>null;export const runSideCall=async()=>{throw Error('Unexpected inference in returned-review fixture')}`,
  './turn':`export const runTurn=input=>globalThis.__completionLoop.backend(input)`,
  './supervisedTurn':`export const runSupervisedTurn=input=>globalThis.__completionLoop.backend(input)`,
  './mcpGateway':`export const cancelGatewayDetach=()=>{};export const detachGateway=async()=>{};export const scheduleGatewayDetach=()=>{}`,
  './memory':`export const enqueueMemoryExtraction=async()=>{};export const stopExtraction=()=>{};export const stopAllExtraction=()=>{}`,
  './recorder':`export const startRecording=()=>{};export const stopRecording=async()=>null`,
  './routines':`export const runRoutine=async()=>{throw Error('Screen replay forbidden')}`,
  '../tools/agent/help':`export const cancelHumanHelpForSession=()=>{}`,
  '../backends/chatTiming':`export const traceChatTiming=()=>{}`,
  '../native/stdioBridge':`export const sendNativeEvent=e=>globalThis.__completionLoop.events.push(e);export const registerNativeHandler=()=>{}`,
  './app/window':`export const focusOrCreateWindow=()=>{throw Error('Window focus forbidden')}`,
  '../app/window':`export const focusOrCreateWindow=()=>{throw Error('Window focus forbidden')}`,
  '../backends/cli/codexAppServer':`export const steerCodexTurn=async()=>{throw Error('Real CLI steering forbidden')}`,
  './ipc/agentRuntime':`export const loopFn=async name=>globalThis.__completionLoop.api?.[name]??null`,
  '../ipc/agentRuntime':`export const loopFn=async name=>globalThis.__completionLoop.api?.[name]??null`,
  '../connectors/githubWatch':`export const githubIssueFingerprint=async()=>{throw Error('Network forbidden')}`,
  '../connectors/gmailWatch':`export const gmailQueryFingerprint=async()=>{throw Error('Network forbidden')}`
}
const bundle=await build({stdin:{contents:`export * from './src/main/agent/loop.ts';export * from './src/main/tasks.ts';export * from './src/main/tasks/clarifications.ts';export * from './src/main/tasks/reviewQuestions.ts';export {broadcast as event} from './src/main/agent/events.ts';export {reviewTaskTool} from './src/main/tools/agent/review.ts';export * from './src/main/agent/messageQueueRuntime.ts';export * from './src/main/routines/webhookDelivery.ts';export * from './src/main/routines/webhookInbox.ts';export * from './src/main/routines/runs.ts';export {tickRoutineScheduler} from './src/main/routines/scheduler.ts';export * from './src/main/store/messageQueue.ts';export * from './src/main/store/routines.ts';export * from './src/main/store/tasks.ts';export * from './src/main/store/bots.ts';export * from './src/main/store/sessions.ts';export * from './src/main/store/activity.ts';export {loadMemory} from './src/main/store/memory.ts';export {ensureBotHome} from './src/main/store/botHome.ts';export {initSettings} from './src/main/settings.ts';export {flushAll} from './src/main/store/jsonStore.ts';export {abortAll,isRunning} from './src/main/agent/cancel.ts';export {setExecutionAgent,clearExecutionAgent} from './src/main/agent/executionAgent.ts';`,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'no-gui-or-providers',setup(b){
  b.onResolve({filter:/.*/},a=>a.path==='./memory'&&!a.importer.includes('/agent/')?undefined:Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined)
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))
  b.onLoad({filter:/\/src\/main\/tasks\.ts$/},async a=>({contents:await readFile(a.path,'utf8')+'\nexport const fixtureInboxBusy=id=>inboxActive.has(id);',loader:'ts'}))
}}]})
async function until(fn){for(let i=0;i<1000;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Actual queue/loop did not reach the expected state')}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'blinky-completion-loop-')),previous=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 await writeFile(join(root,'settings.json'),JSON.stringify({language:'zh-CN',notifications:false,memoryExtraction:'off'}))
 const file=join(root,'chain.mjs');await writeFile(file,bundle.outputFiles[0].contents)
 const state=globalThis.__completionLoop={events:[],calls:[],gate:null,beforeBackend:null,api:null}
 const api=await import(pathToFileURL(file).href);state.api=api
 await api.initSettings();await api.loadMemory();await api.loadBots();await api.loadSessions();await api.loadTasks();await api.loadRoutines();await api.loadMessageQueues();await api.loadActivity()
 const bot=api.createBot({name:'Local chain',backendId:'fixture',modelId:'fixture',followsDefault:false})
 const home=api.ensureBotHome(bot.id);api.saveSession({...home,mode:'agent',cwd:root})
 const routine=await api.createRoutineDurable({botId:bot.id,name:'Local event',instruction:'Controlled local work.',trigger:{kind:'webhook'},notifyPolicy:'quiet'})
 state.backend=async input=>{throw Error('Set the controlled model response explicitly')}

 api.installQueueRuntime()
 async function signal(id='one'){
  const event=await api.acceptWebhookSignal(routine.id,bot.id,id,routine.name,routine.instruction)
  await api.drainWebhookInbox();return event
 }
 async function close(){
  api.cancelReviewQuestions();for(const task of api.listTasks())if(['queued','running'].includes(task.status))await api.cancelBackgroundTask(task.id);api.stopWebhookDelivery();api.suspendQueue(home.id);api.abortAll();state.release?.()
  await until(()=>!api.isRunning(home.id)&&!api.fixtureInboxBusy(home.id)&&!api.isQueueExecuting(home.id)&&!api.isQueueDraining(home.id)&&!api.listTasks().some(task=>api.isRunning(task.sessionId)))
  await new Promise(r=>setTimeout(r,20));await api.flushAll()
  if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=previous
  await rm(root,{recursive:true,force:true})
 }
 return {api,state,root,file,bot,home,routine,signal,close}
}


const q={id:'decision',header:'下一步',kind:'preference',question:'报告已整理，真实设备暂时不可用。先补全离线报告还是等待设备？',options:[{label:'先补报告',description:'完成不依赖设备的已有范围'},{label:'等待设备',description:'保留结果，待设备可用后验证'}]}
function seed(f,name='任务原始目标'){
 const execution=f.api.createSession({cwd:f.root,mode:'agent',botIds:[f.bot.id],activeBotId:f.bot.id,messages:[],todos:[],title:name,archived:true})
 const task=f.api.createTaskRecord(f.bot.id,execution.id,name,name,{sourceSessionId:f.home.id,executionAgent:{backendId:'fixture',modelId:'fixture'}})
 f.api.completeAgentTask(task.id,'已有中间结果；实际目标仍未验收。')
 return f.api.getTask(task.id)
}
const envelope=f=>{const m=f.api.getSession(f.home.id).messages.filter(m=>m.id.startsWith('agent-result-context-')).at(-1);return m&&JSON.parse(m.content.match(/<agent_result>([\s\S]*?)<\/agent_result>/)[1])}
const final=(f,input,text='Internal assessment')=>{const session=f.api.getSession(input.session.id),message={id:crypto.randomUUID(),role:'assistant',botId:input.bot.id,content:text,internal:true,createdAt:Date.now()};f.api.saveSession({...session,messages:[...session.messages,message]});return {status:'final',message}}
const reviewTool=(f,input,taskId,outcome,summary,question)=>f.api.reviewTaskTool.handler({task_id:taskId,outcome,summary,evidence:outcome==='complete_claimed'?['fixture observation']:[],...(question?{question}:{})},{sessionId:f.home.id,botId:f.bot.id,signal:input.signal,host:{reviewTask:f.api.reviewBackgroundTask}})
const waiting=async(f,taskId)=>{let value;await until(async()=>{value=(await f.api.listTaskClarifications(taskId)).find(q=>q.status==='waiting_user');return value});return value}

test('real inbox/loop releases Bot while waiting, handles independent result, and a canonical answer resumes original task context',async()=>{
 const f=await fixture()
 try{
  const original=seed(f),seen=[]
  f.state.backend=async input=>{
   const data=envelope(f);seen.push(data.taskId)
   if(data.taskId===original.id&&!data.completion.userDecision)await reviewTool(f,input,data.taskId,'blocked','报告已有结果，需要选择设备不可用时的后续。',q)
   else if(data.taskId===original.id){
    assert.deepEqual(data.completion.userDecision.answers,{decision:['先补报告']})
    const next=await f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'先补全不依赖设备的报告；保持原范围和实际验收余项',undefined,original.id,input.signal)
    assert.equal(next.sessionId,original.sessionId)
   }else await reviewTool(f,input,data.taskId,data.status==='failed'?'blocked':'complete_claimed','核对了本测试要求的独立结果或保留执行边界。')
   return final(f,input)
  }
  f.api.installTaskInbox();const question=await waiting(f,original.id)
  await until(()=>!f.api.isRunning(f.home.id)&&f.api.getTask(original.id).deliveryStatus==='delivered')
  assert.equal(f.api.getTask(original.id).review.outcome,'blocked')
  const independent=seed(f,'独立范围');f.api.event({type:'session-updated',session:f.api.getSession(f.home.id)})
  await until(()=>f.api.getTask(independent.id).review?.outcome==='complete_claimed')
  assert.equal((await f.api.listTaskClarifications(original.id))[0].status,'waiting_user')
  // Do not start the continuation executor in this test: stop its first turn
  // with an ordinary controlled error, preserving the original context/claim.
  const prior=f.state.backend;f.state.backend=async input=>input.session.id===f.home.id?prior(input):(()=>{throw Error('controlled continuation boundary')})()
  await f.api.answerTaskClarification(question.id,{decision:['先补报告']})
  await until(()=>f.api.listTasks().some(t=>t.continuedFromTaskId===original.id))
  const continued=f.api.listTasks().find(t=>t.continuedFromTaskId===original.id)
  assert.equal(continued.sessionId,original.sessionId)
  assert.equal(seen.filter(id=>id===original.id).length,2)
  await f.api.answerTaskClarification(question.id,{decision:['先补报告']})
  assert.equal(f.api.listTasks().filter(t=>t.continuedFromTaskId===original.id).length,1)
 }finally{await f.close()}
})

test('revised assessment preserves blocked history and consumes the exact reply without repeated wake',async()=>{
 const f=await fixture()
 try{
  const task=seed(f);let rounds=0
  f.state.backend=async input=>{const data=envelope(f);rounds++;await reviewTool(f,input,task.id,data.completion.userDecision?'complete_claimed':'blocked',data.completion.userDecision?'已有明确选择并核对本测试结果。':'等待用户选择。',data.completion.userDecision?undefined:q);return final(f,input)}
  f.api.installTaskInbox();const question=await waiting(f,task.id)
  await until(()=>!f.api.isRunning(f.home.id))
  await f.api.answerTaskClarification(question.id,{decision:['等待设备']})
  await until(()=>f.api.getTask(task.id).review?.outcome==='complete_claimed')
  const saved=f.api.getTask(task.id);assert.equal(saved.review.respondedTo,question.id);assert.equal(saved.reviewHistory[0].outcome,'blocked')
  f.api.event({type:'session-updated',session:f.api.getSession(f.home.id)});await new Promise(r=>setTimeout(r,30));assert.equal(rounds,2)
 }finally{await f.close()}
})

test('unrecorded review gets a specific contract correction, then an unchanged failure is visible and held',async()=>{
 const f=await fixture()
 try{
  const task=seed(f);let rounds=0
  f.state.backend=async input=>{rounds++;return final(f,input,'No durable assessment')}
  f.api.installTaskInbox()
  await until(()=>f.api.getTask(task.id).reviewFailure)
  assert.equal(rounds,2);assert.equal(f.api.getTask(task.id).deliveryStatus,'uncertain');assert.equal(f.api.getTask(task.id).review,undefined)
  assert.ok(f.api.getSession(f.home.id).messages.some(m=>m.id==='agent-review-unavailable-'+task.id))
  f.api.event({type:'session-updated',session:f.api.getSession(f.home.id)});await new Promise(r=>setTimeout(r,30));assert.equal(rounds,2)
  const s=f.api.getSession(f.home.id);f.api.saveSession({...s,messages:[...s.messages,{id:'new-fact',role:'user',content:'补充实际观察，继续核对原目标。',createdAt:Date.now()}]})
  f.state.backend=async input=>{rounds++;await reviewTool(f,input,task.id,'complete_claimed','按补充观察核对了测试结果。');return final(f,input)}
  f.api.event({type:'session-updated',session:f.api.getSession(f.home.id)})
  await until(()=>f.api.getTask(task.id).review?.outcome==='complete_claimed');assert.equal(rounds,3)
 }finally{await f.close()}
})

test('cancelling a decision or stopping the owning source never supplies a reply or restarts execution',async()=>{
 for(const mode of ['cancel','stop']){
  const f=await fixture()
  try{
   const task=seed(f);let rounds=0
   f.state.backend=async input=>{rounds++;await reviewTool(f,input,task.id,'blocked','等待实际选择。',q);return final(f,input)}
   f.api.installTaskInbox();const question=await waiting(f,task.id);await until(()=>!f.api.isRunning(f.home.id))
   if(mode==='cancel')await f.api.cancelTaskClarification(question.id);else await f.api.stopSession(f.home.id)
   await assert.rejects(f.api.answerTaskClarification(question.id,{decision:['先补报告']}))
   f.api.event({type:'session-updated',session:f.api.getSession(f.home.id)});await new Promise(r=>setTimeout(r,30))
   assert.equal(rounds,1);assert.equal(f.api.listTasks().some(t=>t.continuedFromTaskId===task.id),false)
   assert.equal(f.api.getTask(task.id).review.outcome,'blocked')
  }finally{await f.close()}
 }
})

test('a missing-assessment observation can recover through a specific correction without asking a user or replaying execution',async()=>{
 const f=await fixture()
 try{
  const task=seed(f);let rounds=0
  f.state.backend=async input=>{rounds++;if(rounds>1)await reviewTool(f,input,task.id,'complete_claimed','已记录本测试要求的复核。');return final(f,input)}
  f.api.installTaskInbox();await until(()=>f.api.getTask(task.id).review?.outcome==='complete_claimed')
  assert.equal(rounds,2);assert.ok(f.api.getSession(f.home.id).messages.some(m=>m.id.startsWith('agent-review-contract-'+task.id)))
  assert.equal((await f.api.listTaskClarifications(task.id)).length,0)
 }finally{await f.close()}
})

test('task inbox uses the original responsible Bot even when another Bot is selected in the same source conversation',async()=>{
 const f=await fixture()
 try{
  const other=f.api.createBot({name:'Other',backendId:'fixture',modelId:'fixture',followsDefault:false}),source=f.api.getSession(f.home.id)
  f.api.saveSession({...source,botIds:[f.bot.id,other.id],activeBotId:other.id})
  const task=seed(f)
  f.state.backend=async input=>{assert.equal(input.bot.id,f.bot.id);await reviewTool(f,input,task.id,'complete_claimed','由原负责 Bot 记录测试复核。');return final(f,input)}
  f.api.installTaskInbox();await until(()=>f.api.getTask(task.id).deliveryStatus==='delivered')
  assert.equal(f.api.getSession(f.home.id).activeBotId,other.id)
 }finally{await f.close()}
})

test('fresh process expires unanswered returned-task clarification, retaining blocked state without model or command replay',async()=>{
 const f=await fixture()
 try{
  const task=seed(f)
  f.state.backend=async input=>{await reviewTool(f,input,task.id,'blocked','原始范围仍等待决定。',q);return final(f,input)}
  f.api.installTaskInbox();const question=await waiting(f,task.id);await until(()=>!f.api.isRunning(f.home.id)&&f.api.getTask(task.id).deliveryStatus==='delivered');await f.api.flushAll()
  const code=`globalThis.__completionLoop={events:[],api:null,beforeBackend:null};const api=await import(${JSON.stringify(pathToFileURL(f.file).href)});__completionLoop.api=api;__completionLoop.backend=async()=>{throw Error('Model replay forbidden')};await api.initSettings();await api.loadMemory();await api.loadBots();await api.loadSessions();await api.loadTasks();await api.loadRoutines();await api.loadMessageQueues();await api.loadActivity();api.installTaskInbox();await new Promise(r=>setTimeout(r,50));const requests=await api.listTaskClarifications(${JSON.stringify(task.id)});console.log(JSON.stringify({question:requests.find(r=>r.id===${JSON.stringify(question.id)}).status,review:api.getTask(${JSON.stringify(task.id)}).review.outcome,continuations:api.listTasks().filter(t=>t.continuedFromTaskId===${JSON.stringify(task.id)}).length}));await api.flushAll();`
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,OPENBOT_DATA_DIR:f.root},encoding:'utf8',timeout:10000})
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{question:'expired',review:'blocked',continuations:0})
 }finally{await f.close()}
})

test('fresh process recovers an already-saved canonical answer for original task review exactly once, without resuming a command',async()=>{
 const f=await fixture()
 try{
  const task=seed(f)
  f.state.backend=async input=>{await reviewTool(f,input,task.id,'blocked','先等用户选择。',q);return final(f,input)}
  f.api.installTaskInbox();const question=await waiting(f,task.id);await until(()=>!f.api.isRunning(f.home.id)&&f.api.getTask(task.id).deliveryStatus==='delivered')
  // Suspend the source queue so the saved answer cannot be consumed before
  // this synthetic process-boundary probe. A genuine new process has no live turn.
  f.api.suspendQueue(f.home.id)
  await f.api.answerTaskClarification(question.id,{decision:['先补报告']});await until(()=>f.api.getTask(task.id).deliveryStatus==='pending');await f.api.flushAll()
  const code=`globalThis.__completionLoop={events:[],api:null,beforeBackend:null,calls:0};const api=await import(${JSON.stringify(pathToFileURL(f.file).href)});__completionLoop.api=api;await api.initSettings();await api.loadMemory();await api.loadBots();await api.loadSessions();await api.loadTasks();await api.loadRoutines();await api.loadMessageQueues();await api.loadActivity();__completionLoop.backend=async input=>{__completionLoop.calls++;const request=await api.resolvedReviewQuestion(api.getTask(${JSON.stringify(task.id)}));if(request?.id!==${JSON.stringify(question.id)})throw Error('Original answer association lost');await api.reviewBackgroundTask(${JSON.stringify(f.home.id)},${JSON.stringify(f.bot.id)},${JSON.stringify(task.id)},'complete_claimed','Recorded only the explicit synthetic verification objective',['controlled evidence'],input.signal);return {status:'final',message:{id:'restored-review',content:'controlled assessment'}}};api.installTaskInbox();for(let i=0;i<100&&api.getTask(${JSON.stringify(task.id)}).deliveryStatus!=='delivered';i++)await new Promise(r=>setTimeout(r,10));console.log(JSON.stringify({outcome:api.getTask(${JSON.stringify(task.id)}).review.outcome,respondedTo:api.getTask(${JSON.stringify(task.id)}).review.respondedTo,calls:__completionLoop.calls,continuations:api.listTasks().filter(t=>t.continuedFromTaskId===${JSON.stringify(task.id)}).length}));await api.flushAll();`
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,OPENBOT_DATA_DIR:f.root},encoding:'utf8',timeout:10000})
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{outcome:'complete_claimed',respondedTo:question.id,calls:1,continuations:0})
 }finally{await f.close()}
})

test('a newer assessment closes the old revision question, and only its new canonical reply can wake the task',async()=>{
 const f=await fixture()
 try{
  const task=seed(f)
  f.state.backend=async input=>{await reviewTool(f,input,task.id,'blocked','等待原决定。',q);return final(f,input)}
  f.api.installTaskInbox();const old=await waiting(f,task.id);await until(()=>!f.api.isRunning(f.home.id))
  const s=f.api.getSession(f.home.id);f.api.saveSession({...s,messages:[...s.messages,{id:'changed-goal',role:'user',content:'这次先按新范围核验，旧选项已经过时。',createdAt:1}]})
  const question={...q,id:'new-choice',question:'旧决定已被新范围取代，请选择新范围中需要的设备。'}
  await f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'blocked','已按最新纠偏重新定位，只等待新的决定。',[],undefined,question)
  let current;await until(async()=>{current=(await f.api.listTaskClarifications(task.id)).find(r=>r.id!==old.id&&r.status==='waiting_user');return current})
  assert.equal((await f.api.listTaskClarifications(task.id)).find(r=>r.id===old.id).status,'cancelled')
  await assert.rejects(f.api.answerTaskClarification(old.id,{decision:['先补报告']}))
  assert.equal(current.reviewRecordedAt,f.api.getTask(task.id).review.recordedAt)
  assert.equal(f.api.getTask(task.id).reviewHistory[0].question.id,q.id)
 }finally{await f.close()}
})

test('clarification storage failure remains visibly unfinished without fabricated answer or repeated execution',async()=>{
 const f=await fixture()
 try{
  await writeFile(join(f.root,'task-clarifications'),'synthetic storage boundary')
  const task=seed(f);let rounds=0
  f.state.backend=async input=>{rounds++;await reviewTool(f,input,task.id,'blocked','设备不可用，需要选择后续。',q);return final(f,input)}
  f.api.installTaskInbox()
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.id.startsWith('agent-review-question-unavailable-'+task.id)))
  assert.equal(f.api.getTask(task.id).review.outcome,'blocked');assert.equal(rounds,1)
  assert.equal(f.api.listTasks().some(t=>t.continuedFromTaskId===task.id),false)
 }finally{await f.close()}
})

test('a model completion claim after an answer cannot pass missing explicitly requested file checks',async()=>{
 const f=await fixture()
 try{
  let task=seed(f)
  // Create another durable isolated record with the user's actual output
  // condition; the file intentionally does not exist in this controlled case.
  task=f.api.createTaskRecord(f.bot.id,task.sessionId,'Deliver report.txt and verify it','Missing output',{sourceSessionId:f.home.id,executionAgent:{backendId:'fixture',modelId:'fixture'},acceptance:{root:f.root,files:[{path:'report.txt'}]}})
  f.api.completeAgentTask(task.id,'The executor claims completion')
  const unrelated=f.api.listTasks().find(item=>item.id!==task.id);f.api.updateTaskDelivery(unrelated.id,'delivered')
  f.state.backend=async input=>{const data=envelope(f);await reviewTool(f,input,task.id,data.completion.userDecision?'complete_claimed':'blocked','Controlled assessment',data.completion.userDecision?undefined:q);return final(f,input)}
  f.api.installTaskInbox();const question=await waiting(f,task.id);await until(()=>!f.api.isRunning(f.home.id))
  await f.api.answerTaskClarification(question.id,{decision:['先补报告']})
  await until(()=>f.api.getTask(task.id).reviewFailure)
  assert.equal(f.api.getTask(task.id).review.outcome,'blocked')
  assert.equal(f.api.getTask(task.id).reviewHistory?.length??0,0)
  assert.equal(f.api.getTask(task.id).review.respondedTo,undefined)
 }finally{await f.close()}
})

test('a very fast canonical answer arriving before the first review turn ends is not lost or consumed as completion',async()=>{
 const f=await fixture()
 try{
  const task=seed(f);let rounds=0,questionId
  f.state.backend=async input=>{
   const data=envelope(f);rounds++
   if(!data.completion.userDecision){
    await reviewTool(f,input,task.id,'blocked','等待用户作出实际选择。',q)
    const question=await waiting(f,task.id);questionId=question.id
    assert.equal(f.api.getTask(task.id).deliveryStatus,'delivering')
    await f.api.answerTaskClarification(question.id,{decision:['先补报告']})
    assert.equal(f.api.getTask(task.id).review.outcome,'blocked')
   }else await reviewTool(f,input,task.id,'complete_claimed','按真实回复记录本测试要求的复核结果。')
   return final(f,input)
  }
  f.api.installTaskInbox();await until(()=>f.api.getTask(task.id).review?.outcome==='complete_claimed')
  assert.equal(rounds,2);assert.equal(f.api.getTask(task.id).review.respondedTo,questionId)
 }finally{await f.close()}
})
