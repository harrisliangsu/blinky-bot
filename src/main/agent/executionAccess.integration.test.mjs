/** Actual request/gate/transport code with synthetic IPC and in-memory native transport. No account or CLI is started. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const previous=process.env.OPENBOT_DATA_DIR,root=await mkdtemp(join(tmpdir(),'blinky-access-contract-'));process.env.OPENBOT_DATA_DIR=root
const state={settings:{approvalPolicy:'auto-run',localExecutionPolicy:'always-allow',automaticReview:false,allowlist:[],denylist:[],asklist:[],semanticPermissionRules:[]},events:[],calls:[],questions:[],mode:'clarify',kills:0}
globalThis.__accessSeparation=state
const mocks={
 './taskJudgmentScope':`export const taskJudgmentScope=()=>globalThis.__accessSeparation.internal?{}:undefined`,
 './optionalModules':`export const loadBackendRegistry=async()=>null;export const tryCall=async(fn,fallback)=>fn?fn():fallback`,
 './settingsGateway':`export const settingsStore={get:async()=>globalThis.__accessSeparation.settings}`,
 '../settings':`export const getSettings=()=>globalThis.__accessSeparation.settings;export const onSettingsChanged=()=>()=>{}`,
 './events':`export const broadcast=e=>globalThis.__accessSeparation.events.push(e);export const broadcastError=()=>{}`,
 './cancel':`export const isRunning=()=>false;export const stopAfterRejectedApproval=()=>{}`,
 '../store/mcpSecrets':`export const mcpBearerToken=()=>{throw Error('No credential reads')}`,
 '../tasks/clarifications':`export const requestTaskClarification=async(id,bot,questions)=>{globalThis.__accessSeparation.questions.push({id,bot,questions});return {scope:['fixture']}}`,
 '../spawnProcess':`export async function spawnLines(){
 const s=globalThis.__accessSeparation,queue=[],waiters=[];let closed=false;
 const emit=x=>{const v={stream:'stdout',line:JSON.stringify(x)};const f=waiters.shift();if(f)f({value:v,done:false});else queue.push(v)};
 const child={exitCode:null,signalCode:null,killed:false};
 return {child,lines:{[Symbol.asyncIterator](){return this},next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(closed)return Promise.resolve({done:true});return new Promise(r=>waiters.push(r))}},
 write(line){const q=JSON.parse(line);s.calls.push(q);if(q.method==='initialize')emit({id:q.id,result:{}});
 if(q.method==='thread/resume'&&s.mode==='resume-denied')emit({id:q.id,error:{code:-32000,message:'synthetic resume policy refusal'}});
 else if(q.method==='thread/start'||q.method==='thread/resume')emit({id:q.id,result:{thread:{id:'native-synthetic'},approvalPolicy:s.mode==='downgrade'?'on-request':'never',approvalsReviewer:s.mode==='reviewer-downgrade'?'auto_review':'user',sandbox:{type:s.mode==='downgrade'?'workspaceWrite':'dangerFullAccess'}}});
 if(q.method==='turn/start'){emit({id:q.id,result:{turn:{id:'turn'}}});emit({method:'turn/started',params:{threadId:'native-synthetic',turn:{id:'turn'}}});
 if(s.mode==='denied')emit({method:'item/autoApprovalReview/completed',params:{threadId:'native-synthetic',turnId:'turn',review:{status:'denied',rationale:'synthetic managed refusal'},action:{type:'command',command:'synthetic action'}}});
 else emit({id:900,method:'item/tool/requestUserInput',params:{threadId:'native-synthetic',turnId:'turn',questions:[{id:'scope',header:'Scope',question:'Missing synthetic scope?',options:[{label:'fixture',description:'isolated fixture'}]}]}});}
 if(q.id===900&&!q.method)emit({method:'turn/completed',params:{threadId:'native-synthetic',turn:{id:'turn',status:'completed'}}});},
 kill(){s.kills++;closed=true;child.killed=true;for(const f of waiters.splice(0))f({done:true})},closeStdin(){},exit:Promise.resolve({code:0}),timedOut:()=>false,stdinError:()=>null};}`
}
const bundle=await build({stdin:{contents:`export {buildChatRequest} from './chatRequest.ts';export {openChatStream} from './backendGateway.ts';export {setExecutionAgent,clearExecutionAgent,revokeExecutorAccess} from './executionAgent.ts';export {runCodexAppServer,stopWarmCodex} from '../backends/cli/codexAppServer.ts';export {flushAll} from '../store/jsonStore.ts'`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'isolated-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const artifact=join(root,'contract.mjs');await writeFile(artifact,bundle.outputFiles[0].contents);const api=await import(pathToFileURL(artifact).href)
const bot={id:'owner',backendId:'codex',modelId:'fixture',systemPrompt:'Synthetic',tools:[],computerTarget:{kind:'local'}}
function request(id='worker') {return api.buildChatRequest({session:{id,mode:'agent',cwd:root},bot,settings:state.settings,signal:new AbortController().signal,mode:'supervised',messages:[{role:'user',content:'Synthetic metadata only'}],tools:[]})}
const run=req=>api.runCodexAppServer({binaryPath:'/never-launched',ctx:{cwd:root,model:'fixture',extraArgs:[]},req})
async function collect(req){const chunks=[];for await(const c of run(req))chunks.push(c);return chunks}

test('Bot keeps its manual setting while an opted-in executor uses full access and still routes native clarification to the Bot',{timeout:15000},async()=>{
 api.setExecutionAgent('worker',{backendId:'codex',modelId:'fixture',accessMode:'full-access'},'owner')
 try{
  assert.equal(request('home').executionAccess,undefined);assert.equal(request('home').approvalPolicy,'ask-every-time')
  state.internal=true;assert.equal(request().executionAccess,undefined,'protected internal consideration never gets full access');state.internal=false
  const req=request();assert.equal(req.executionAccess,'full-access');state.calls=[];state.questions=[];state.mode='clarify'
  const chunks=await collect(req);assert.ok(chunks.some(c=>c.type==='done'))
  assert.equal(state.questions[0].id,'worker');assert.equal(state.questions[0].bot,'owner')
  const start=state.calls.find(c=>c.method==='thread/start'),turn=state.calls.find(c=>c.method==='turn/start')
  assert.equal(start.params.sandbox,'danger-full-access');assert.equal(start.params.approvalPolicy,'never')
  assert.deepEqual(turn.params.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(turn.params.approvalsReviewer,'user')
  assert.deepEqual(state.calls.find(c=>c.id===900&&!c.method).result,{answers:{scope:{answers:['fixture']}}})
  api.stopWarmCodex();state.calls=[];await collect(req)
  assert.equal(state.calls.find(c=>c.method==='thread/resume').params.sandbox,'danger-full-access')
  assert.deepEqual(state.calls.find(c=>c.method==='turn/start').params.sandboxPolicy,{type:'dangerFullAccess'})
 }finally{api.stopWarmCodex();api.clearExecutionAgent('worker')}
})
test('a managed downgrade is reported before any model turn; an explicit refusal is still terminal without retry',{timeout:15000},async()=>{
 api.setExecutionAgent('worker',{backendId:'codex',modelId:'fixture',accessMode:'full-access'},'owner')
 try{
  state.calls=[];state.mode='downgrade';await assert.rejects(collect(request()),/did not confirm.*full-access/)
  assert.equal(state.calls.some(c=>c.method==='turn/start'),false)
  state.calls=[];state.mode='reviewer-downgrade';await assert.rejects(collect(request()),/did not confirm.*full-access/)
  assert.equal(state.calls.some(c=>c.method==='turn/start'),false)
  state.calls=[];state.mode='denied';await assert.rejects(collect(request()),/synthetic managed refusal/)
  assert.equal(state.calls.filter(c=>c.method==='turn/start').length,1)
 }finally{api.stopWarmCodex();api.clearExecutionAgent('worker')}
})
test('revoking executor access aborts the native stream and never starts an unsupported backend',{timeout:15000},async()=>{
 api.setExecutionAgent('worker',{backendId:'codex',modelId:'fixture',accessMode:'full-access'},'owner')
 let started=0
 const backend={id:'codex',label:'Synthetic Codex',kind:'agent-cli',async *chat(req){started++;yield {type:'text',delta:'started'};await new Promise(resolve=>req.signal.addEventListener('abort',resolve,{once:true}));req.signal.throwIfAborted()}}
 try{
  const stream=await api.openChatStream(backend,request(),{enabled:true});const it=stream[Symbol.asyncIterator]();await it.next()
  const pending=it.next();await Promise.resolve();api.revokeExecutorAccess('owner');await assert.rejects(pending,/cancelled|aborted/i)
  assert.equal(started,1)
  await assert.rejects(api.openChatStream({...backend,id:'pi'},{...request(),executionAccess:'full-access'},{enabled:true}),/does not support/)
  assert.equal(started,1)
 }finally{api.clearExecutionAgent('worker')}
})
test('a failed full-access resume never retries by starting a new thread',{timeout:15000},async()=>{
 api.setExecutionAgent('worker',{backendId:'codex',modelId:'fixture',accessMode:'full-access'},'owner')
 try{
  state.mode='clarify';await collect(request());api.stopWarmCodex()
  state.calls=[];state.mode='resume-denied'
  await assert.rejects(collect(request()),/synthetic resume policy refusal/)
  assert.equal(state.calls.filter(c=>c.method==='thread/resume').length,1)
  assert.equal(state.calls.some(c=>c.method==='thread/start'||c.method==='turn/start'),false)
 }finally{api.stopWarmCodex();api.clearExecutionAgent('worker')}
})
test.after(async()=>{api.stopWarmCodex();await api.flushAll();if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=previous;await rm(root,{recursive:true,force:true})})
