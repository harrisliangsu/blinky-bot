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
  './backendGateway':`export const getBackendInfo=async()=>{await globalThis.__webhookChain.beforeBackend?.();return {kind:'api'}};export const getBackend=async()=>{throw Error('Hidden backend discovery forbidden')};export const runSideCall=async()=>{throw Error('Model side calls forbidden')}`,
  '../agent/backendGateway':`export const getBackend=async()=>null;export const runSideCall=async()=>{throw Error('Unexpected inference in returned-review fixture')}`,
  './turn':`export const runTurn=input=>globalThis.__webhookChain.backend(input)`,
  './supervisedTurn':`export const runSupervisedTurn=input=>globalThis.__webhookChain.backend(input)`,
  './mcpGateway':`export const cancelGatewayDetach=()=>{};export const detachGateway=async()=>{};export const scheduleGatewayDetach=()=>{}`,
  './memory':`export const enqueueMemoryExtraction=async()=>{};export const stopExtraction=()=>{};export const stopAllExtraction=()=>{}`,
  './recorder':`export const startRecording=()=>{};export const stopRecording=async()=>null`,
  './routines':`export const runRoutine=async()=>{throw Error('Screen replay forbidden')}`,
  '../tools/agent/help':`export const cancelHumanHelpForSession=()=>{}`,
  '../backends/chatTiming':`export const traceChatTiming=()=>{}`,
  '../native/stdioBridge':`export const sendNativeEvent=e=>globalThis.__webhookChain.events.push(e);export const registerNativeHandler=()=>{}`,
  './app/window':`export const focusOrCreateWindow=()=>{throw Error('Window focus forbidden')}`,
  '../app/window':`export const focusOrCreateWindow=()=>{throw Error('Window focus forbidden')}`,
  '../backends/cli/codexAppServer':`export const steerCodexTurn=async()=>{throw Error('Real CLI steering forbidden')}`,
  '../ipc/agentRuntime':`export const loopFn=async name=>globalThis.__webhookChain.api?.[name]??null`,
  '../connectors/githubWatch':`export const githubIssueFingerprint=async()=>{throw Error('Network forbidden')}`,
  '../connectors/gmailWatch':`export const gmailQueryFingerprint=async()=>{throw Error('Network forbidden')}`
}
const bundle=await build({stdin:{contents:`export * from './src/main/agent/loop.ts';export * from './src/main/agent/messageQueueRuntime.ts';export * from './src/main/routines/webhookDelivery.ts';export * from './src/main/routines/webhookInbox.ts';export * from './src/main/routines/runs.ts';export {tickRoutineScheduler} from './src/main/routines/scheduler.ts';export * from './src/main/store/messageQueue.ts';export * from './src/main/store/routines.ts';export * from './src/main/store/tasks.ts';export * from './src/main/store/bots.ts';export * from './src/main/store/sessions.ts';export * from './src/main/store/activity.ts';export {loadMemory} from './src/main/store/memory.ts';export {ensureBotHome} from './src/main/store/botHome.ts';export {initSettings} from './src/main/settings.ts';export {flushAll} from './src/main/store/jsonStore.ts';export {abortAll,isRunning} from './src/main/agent/cancel.ts';export {setExecutionAgent,clearExecutionAgent} from './src/main/agent/executionAgent.ts';`,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'no-gui-or-providers',setup(b){
  b.onResolve({filter:/.*/},a=>a.path==='./memory'&&!a.importer.includes('/agent/')?undefined:Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined)
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))
}}]})
async function until(fn){for(let i=0;i<1000;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Actual queue/loop did not reach the expected state')}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'blinky-webhook-chain-')),previous=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 await writeFile(join(root,'settings.json'),JSON.stringify({language:'zh-CN',notifications:false,memoryExtraction:'off'}))
 const file=join(root,'chain.mjs');await writeFile(file,bundle.outputFiles[0].contents)
 const state=globalThis.__webhookChain={events:[],calls:[],gate:null,beforeBackend:null,api:null}
 const api=await import(pathToFileURL(file).href);state.api=api
 await api.initSettings();await api.loadMemory();await api.loadBots();await api.loadSessions();await api.loadTasks();await api.loadRoutines();await api.loadMessageQueues();await api.loadActivity()
 const bot=api.createBot({name:'Local chain',backendId:'fixture',modelId:'fixture',followsDefault:false})
 const home=api.ensureBotHome(bot.id);api.saveSession({...home,mode:'agent',cwd:root})
 const routine=await api.createRoutineDurable({botId:bot.id,name:'Local event',instruction:'Controlled local work.',trigger:{kind:'webhook'},notifyPolicy:'quiet'})
 state.backend=async input=>{
  state.calls.push(input.bot.id)
  const last=api.getSession(home.id).messages.filter(m=>m.role==='user').at(-1)
  assert.equal(api.isSessionMessageDurable(home.id,last.id),true)
  const running=(await api.listRoutineRuns(routine.id)).find(r=>r.webhook.signalId===last.id)
  assert.equal(running.status,'running');assert.ok(running.startedAt)
  if(state.gate)await new Promise((release,reject)=>{
    state.release=release
    input.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true})
  })
  const s=api.getSession(home.id),message={id:crypto.randomUUID(),role:'assistant',botId:input.bot.id,content:state.result??'Local result.',createdAt:Date.now(),...(input.internalAssistant?{internal:true}:{})}
  api.saveSession({...s,messages:[...s.messages,message]})
  return {status:'final',message}
 }
 api.installQueueRuntime()
 async function signal(id='one'){
  const event=await api.acceptWebhookSignal(routine.id,bot.id,id,routine.name,routine.instruction)
  await api.drainWebhookInbox();return event
 }
 async function close(){
  api.stopWebhookDelivery();api.suspendQueue(home.id);api.abortAll();state.release?.()
  await until(()=>!api.isRunning(home.id)&&!api.isQueueExecuting(home.id)&&!api.isQueueDraining(home.id))
  await new Promise(r=>setTimeout(r,20));await api.flushAll()
  if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=previous
  await rm(root,{recursive:true,force:true})
 }
 return {api,state,root,file,bot,home,routine,signal,close}
}

test('actual Webhook inbox → durable queue → loop → executor finishes quietly and ignores duplicate event',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  state.gate=true
  const event=await f.signal()
  await until(()=>state.release)
  assert.equal(api.getMessageQueue(f.home.id).items[0].status,'processing')
  assert.equal((await api.listRoutineRuns(f.routine.id))[0].status,'running')
  state.release()
  await until(async()=>(await api.listRoutineRuns(f.routine.id))[0]?.notificationState==='quiet')
  await until(()=>api.getMessageQueue(f.home.id).items.length===0)
  const run=(await api.listRoutineRuns(f.routine.id))[0]
  assert.equal(run.status,'finished');assert.equal(run.webhook.signalId,event.id);assert.equal(run.result,'Local result.')
  assert.equal(api.listActivity().length,0)
  await f.signal();await new Promise(r=>setTimeout(r,30))
  assert.equal(state.calls.length,1)
 }finally{await f.close()}
})

test('queued cancellation records no execution; a new event establishes its first on-change baseline',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  await api.updateRoutineDurable(f.routine.id,{notifyPolicy:'on_change'})
  api.suspendQueue(f.home.id);await api.setQueuePaused(f.home.id,true)
  const event=await f.signal()
  assert.equal(state.calls.length,0);assert.deepEqual(await api.listRoutineRuns(f.routine.id),[])
  await api.removeQueuedItem(f.home.id,event.id)
  const skipped=(await api.listRoutineRuns(f.routine.id))[0]
  assert.equal(skipped.status,'skipped');assert.equal(skipped.startedAt,undefined)
  api.unsuspendQueue(f.home.id);await api.setQueuePaused(f.home.id,false)
  await f.signal('two')
  await until(async()=>(await api.listRoutineRuns(f.routine.id)).some(r=>r.notificationState==='baseline'))
  assert.equal(state.calls.length,1);assert.equal(api.listActivity().length,0)
  state.result='Changed local result.'
  await until(()=>!api.isRunning(f.home.id));await f.signal('three')
  await until(async()=>(await api.listRoutineRuns(f.routine.id)).some(r=>r.notificationState==='recorded'))
  assert.equal(api.listActivity().length,1)
 }finally{await f.close()}
})

test('stopping a started queue turn retains unknown result and does not auto-run the next waiting event',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  state.gate=true;await f.signal();await until(()=>state.release)
  api.suspendQueue(f.home.id);await api.pauseQueueIfNeeded(f.home.id)
  await f.signal('next')
  await api.stopSession(f.home.id)
  await until(async()=>(await api.listRoutineRuns(f.routine.id))[0]?.status==='unknown')
  assert.equal(state.calls.length,1)
  assert.equal(api.getMessageQueue(f.home.id).paused,true)
  assert.equal(api.getMessageQueue(f.home.id).items.some(item=>item.status==='waiting'),true)
  assert.equal(api.listActivity().length,0)
 }finally{await f.close()}
})

test('actual loop reports early rejection as not started even after transcript acknowledgement',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  let settled
  await api.sendMessage(f.home.id,'Controlled direct gate',undefined,{id:'direct-gate',createdAt:Date.now(),onRecorded:async()=>api.flushAll(),beforeFirstTurn:async()=>false,onSettled:async value=>{settled=value}})
  assert.equal(state.calls.length,0);assert.equal(settled.status,'not_started')
  assert.equal(api.isSessionMessageDurable(f.home.id,'direct-gate'),true)
 }finally{await f.close()}
})

test('actual swallowed executor error becomes failed journal plus interrupted queue, never automatic retry',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  state.backend=async input=>{state.calls.push(input.bot.id);throw Error('Controlled executor failure')}
  await f.signal()
  await until(async()=>(await api.listRoutineRuns(f.routine.id))[0]?.status==='failed')
  await until(()=>!api.isQueueExecuting(f.home.id))
  const queue=api.getMessageQueue(f.home.id)
  assert.equal(queue.paused,true);assert.equal(queue.items[0].status,'interrupted')
  assert.match((await api.listRoutineRuns(f.routine.id))[0].detail,/Controlled executor failure/)
  await f.signal('later')
  assert.equal(state.calls.length,1)
  assert.equal(api.listActivity().length,0)
 }finally{await f.close()}
})

test('actual result-review loop keeps original Bot across async selection change and records delivery once',async()=>{
 const f=await fixture(),{api,state}=f
 try{
  const other=api.createBot({name:'Other',backendId:'fixture',modelId:'fixture',followsDefault:false})
  api.saveSession({...api.getSession(f.home.id),botIds:[f.bot.id,other.id]})
  const task=await api.createTaskRecordDurable(f.bot.id,'private','Original objective','Review fixture',{sourceSessionId:f.home.id,executionAgent:{backendId:'fixture',modelId:'fixture'}})
  api.completeAgentTask(task.id,'Controlled result.')
  state.beforeBackend=async()=>{api.saveSession({...api.getSession(f.home.id),activeBotId:other.id})}
  state.backend=async input=>{
    state.calls.push(input.bot.id)
    await api.storeTaskReviewDurable(task.id,{outcome:'complete_claimed',summary:'Local evidence checked',evidence:['fixture'],recordedAt:Date.now()})
    return {status:'final',message:{id:'review',content:'Internal assessment'}}
  }
  let delivered=0
  assert.equal(await api.receiveAgentResult(f.home.id,task.id,task.title,'Controlled result.',async()=>{delivered++;api.updateTaskDelivery(task.id,'delivered');await api.flushAll()}),true)
  assert.deepEqual(state.calls,[f.bot.id]);assert.equal(api.getSession(f.home.id).activeBotId,other.id)
  assert.equal(delivered,1);assert.equal(api.getTask(task.id).deliveryStatus,'delivered')
 }finally{await f.close()}
})

test('fresh Node restart pauses the real queue and recovers its started event without replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-webhook-restart-')),file=join(root,'chain.mjs')
 try{
  await writeFile(file,bundle.outputFiles[0].contents)
  await writeFile(join(root,'settings.json'),JSON.stringify({language:'zh-CN',notifications:false,memoryExtraction:'off'}))
  const init=`globalThis.__webhookChain={events:[],api:null,beforeBackend:null};const api=await import(${JSON.stringify(pathToFileURL(file).href)});globalThis.__webhookChain.api=api;await api.initSettings();await api.loadMemory();await api.loadBots();await api.loadSessions();await api.loadTasks();await api.loadRoutines();await api.loadMessageQueues();await api.loadActivity();`
  const seed=spawnSync(process.execPath,['--input-type=module','-e',init+`
    const bot=api.createBot({name:'Restart fixture',backendId:'fixture',modelId:'fixture'}),home=api.ensureBotHome(bot.id);api.saveSession({...home,mode:'agent',cwd:process.env.OPENBOT_DATA_DIR});
    const routine=await api.createRoutineDurable({botId:bot.id,name:'Restart',instruction:'Local only.',trigger:{kind:'webhook'},notifyPolicy:'quiet'});
    const event=await api.acceptWebhookSignal(routine.id,bot.id,'restart-event','Restart','Local only.');
    globalThis.__webhookChain.backend=async()=>{await api.flushAll();console.log(JSON.stringify({home:home.id,routine:routine.id,event:event.id}));process.exit(0)};
    api.installQueueRuntime();await api.drainWebhookInbox();await new Promise(r=>setTimeout(r,3000));throw Error('Expected the executor boundary');
  `],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:15000})
  assert.equal(seed.status,0,seed.stderr);const saved=JSON.parse(seed.stdout.trim())
  const resumed=spawnSync(process.execPath,['--input-type=module','-e',init+`
    globalThis.__webhookChain.backend=async()=>{throw Error('Restart must not execute')};await api.initializeRoutineRuns();api.installQueueRuntime();await api.drainWebhookInbox();await new Promise(r=>setTimeout(r,30));
    console.log(JSON.stringify({queue:api.getMessageQueue(${JSON.stringify(saved.home)}),runs:await api.listRoutineRuns(${JSON.stringify(saved.routine)})}));
  `],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:15000})
  assert.equal(resumed.status,0,resumed.stderr);const result=JSON.parse(resumed.stdout.trim())
  assert.equal(result.queue.paused,true);assert.equal(result.queue.items[0].status,'interrupted')
  assert.equal(result.runs.length,1);assert.equal(result.runs[0].status,'unknown');assert.equal(result.runs[0].webhook.signalId,saved.event)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('private execution pins its configured Bot even when UI selection changes; removal cannot fall back to another Bot',async()=>{
 const f=await fixture(),{api,state}=f
 const other=api.createBot({name:'Other private Bot',backendId:'fixture',modelId:'other',followsDefault:false})
 const session=api.createSession([f.bot.id,other.id])
 api.saveSession({...session,activeBotId:other.id,mode:'agent',archived:true,cwd:f.root})
 api.setExecutionAgent(session.id,{backendId:'fixture',modelId:'private-snapshot'},f.bot.id)
 try{
  state.backend=async input=>{
   state.calls.push(input.bot.id);assert.equal(input.bot.modelId,'private-snapshot')
   const message={id:crypto.randomUUID(),role:'assistant',botId:input.bot.id,content:'Private execution result.',createdAt:Date.now()}
   api.saveSession({...api.getSession(session.id),messages:[...api.getSession(session.id).messages,message]})
   return {status:'final',message}
  }
  await api.sendMessage(session.id,'Private controlled work.')
  assert.deepEqual(state.calls,[f.bot.id]);assert.equal(api.getSession(session.id).activeBotId,other.id)
  api.saveSession({...api.getSession(session.id),botIds:[other.id]})
  await api.sendMessage(session.id,'Must not go to another Bot.')
  assert.equal(state.calls.length,1)
 }finally{api.clearExecutionAgent(session.id);await f.close()}
})
