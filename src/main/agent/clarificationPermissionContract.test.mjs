/** Cross-snapshot contract probes. No real app, account, CLI, or network is used. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const state={settings:{approvalPolicy:'ask-every-time',localExecutionPolicy:'ask-every-time',automaticReview:true,allowlist:['*'],denylist:[],asklist:[]},events:[],listeners:[],backends:new Map(),nativeAttempts:0,piCalls:[],requests:[],reply:{answers:{format:{kind:'decision',answer:'Markdown',reason:'An ordinary reversible format choice',routineReversible:true,requiresUserAuthorization:false}}}}
globalThis.__clarificationPermissionContract=state
const mocks={
 './settingsGateway':`export const settingsStore={get:async()=>globalThis.__clarificationPermissionContract.settings,append(){throw Error('No permission changes in this probe')}}`,
 '../settings':`export const getSettings=()=>globalThis.__clarificationPermissionContract.settings;export const onSettingsChanged=fn=>{globalThis.__clarificationPermissionContract.listeners.push(fn);return()=>{}}`,
 './events':`export const broadcast=e=>globalThis.__clarificationPermissionContract.events.push(e);export const broadcastError=()=>{};export const piMapper=()=>()=>undefined`,
 './cancel':`export const isRunning=()=>false;export const stopAfterRejectedApproval=()=>{throw Error('Must not stop a real turn')}`,
 './optionalModules':`export const loadBackendRegistry=async()=>({getBackend:id=>globalThis.__clarificationPermissionContract.backends.get(id)});export const tryCall=async(fn,fallback)=>fn?fn():fallback`,
 '../backends/vaultRedaction':`export const redactSecrets=x=>x`,
 './vaultRedaction':`export const redactSecrets=x=>x;export const diagnosticTail=xs=>xs.join('');export const secretsForRedaction=()=>[]`,
 '../spawnProcess':`export async function spawnLines(){globalThis.__clarificationPermissionContract.nativeAttempts++;throw Error('A native process must not start in this probe')}`,
 './spec':`export const commandFor=()=>'/synthetic/pi';export const CLI_DEFAULT_MODEL={id:'default',label:'Default'};export const modelFlag=()=>[];export const readCliOptions=cfg=>({cwd:'/synthetic',extraArgs:cfg.extraArgs??[]});export const resolveBinary=async()=>'/synthetic/pi';export const runContext=(model,opts)=>({model,...opts})`,
 './stdioJson':`export const captureCli=async()=>{throw Error('No CLI detection in this probe')};export async function* runStdioJson(run){globalThis.__clarificationPermissionContract.piCalls.push(run);yield {type:'text',delta:JSON.stringify(globalThis.__clarificationPermissionContract.reply)};yield {type:'done'}}`
}
const bundle=await build({stdin:{contents:`export {runSideCall,openChatStream} from './backendGateway.ts';export {respondToApproval,pendingCount} from './approval.ts';export {runCodexAppServer} from '../backends/cli/codexAppServer.ts';export {codexSafety} from '../backends/cli/codexSafety.ts';export {openAiCompatibleBackend} from '../backends/openaiCompatible.ts';export {piBackend} from '../backends/cli/pi.ts';export {evaluate} from './approvalPolicy.ts'`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'isolated-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const originalFetch=globalThis.fetch
// Exercise the actual OpenAI request builder/parser while replacing only HTTP transport.
globalThis.fetch=async(url,init)=>{
 assert.equal(String(url),'https://pure-inference.invalid/v1/chat/completions')
 state.requests.push(JSON.parse(init.body))
 if(init.signal.aborted)throw init.signal.reason
 return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(state.reply)}}]}),{headers:{'content-type':'application/json'}})
}
process.once('beforeExit',()=>{globalThis.fetch=originalFetch})
const apiBackend=api.openAiCompatibleBackend({id:'custom-pure-fixture',label:'Pure inference fixture',baseUrl:'https://pure-inference.invalid/v1',keyHint:'synthetic only'})
const codexBackend={id:'codex',label:'Codex',kind:'agent-cli',chat:req=>api.runCodexAppServer({binaryPath:'/must-not-run',ctx:{model:'fixture',cwd:'/synthetic',extraArgs:[]},req})}
state.backends.set('openai',{...apiBackend,id:'openai',chat:(req,cfg)=>apiBackend.chat(req,{...cfg,baseUrl:'https://pure-inference.invalid/v1',apiKey:undefined})});state.backends.set(apiBackend.id,apiBackend);state.backends.set('codex',codexBackend);state.backends.set('pi',api.piBackend)
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const req=()=>({model:'fixture',readOnly:true,disableNativeTools:true,cwd:'/synthetic',signal:new AbortController().signal,messages:[{role:'system',content:'Return only the answer JSON, with no tools.'},{role:'user',content:'Choose a reversible internal report format.'}]})
function reset(policy='ask-every-time'){state.settings={...state.settings,localExecutionPolicy:policy};state.events.length=0;state.requests.length=0;state.piCalls.length=0;state.nativeAttempts=0}
const approvals=()=>state.events.filter(e=>e.type==='approval-request').map(e=>e.request)

test('pure API inference works under all local modes without tools, native tasks, or approval changes',async()=>{
 for(const mode of ['always-allow','ask-every-time','never-allow']){
  reset(mode)
  const value=await api.runSideCall(apiBackend.id,req(),state.settings)
  assert.equal(JSON.parse(value.text).answers.format.answer,'Markdown')
  assert.equal(value.calls.length,0);assert.equal(state.requests.length,1)
  assert.equal('tools' in state.requests[0],false);assert.equal('tool_choice' in state.requests[0],false)
  assert.equal(approvals().length,0);assert.equal(state.nativeAttempts,0)
 }
})
test('pi side calls retain verified no-tools/no-extensions flags and reject tool-enabling extra arguments',async()=>{
 reset()
 assert.ok(await api.runSideCall('pi',req(),state.settings))
 assert.ok(state.piCalls[0].args.includes('--no-tools'));assert.ok(state.piCalls[0].args.includes('--no-extensions'))
 assert.equal(await api.runSideCall('pi',req(),{...state.settings,backends:{pi:{enabled:true,extraArgs:['--tools','read']}}}),null)
 assert.equal(state.piCalls.length,1);assert.equal(approvals().length,0)
})
test('the ordinary Codex task transport still refuses caller-only disableNativeTools before spawn',async()=>{
 assert.deepEqual(api.codexSafety(req()),{approvalPolicy:'never',sandbox:'read-only',approvalsReviewer:'user'})
 reset()
 await assert.rejects(async()=>{for await(const c of codexBackend.chat(req())){}},/cannot safely disable/)
 assert.equal(state.nativeAttempts,0)
})
test('a source session cannot turn the ordinary unverified task transport into pure inference',async()=>{
 reset()
 const pending=api.openChatStream(codexBackend,{...req(),localExecutionSessionId:'source-bot-chat'},{enabled:true})
 await tick();assert.equal(approvals().length,1);assert.equal(approvals()[0].sessionId,'source-bot-chat');assert.equal(approvals()[0].force,true)
 api.respondToApproval(approvals()[0].id,'approve')
 const stream=await pending
 await assert.rejects(async()=>{for await(const c of stream){}},/cannot safely disable/)
 assert.equal(state.nativeAttempts,0)
})
test('an explicitly controlled native task with a source session requires each fresh decision; rejection and cancellation do not start it',async()=>{
 reset();let starts=0
 const controlled={id:'fixture-native',label:'Controlled native fixture',kind:'agent-cli',chat:async function*(){starts++;yield {type:'done'}}}
 const base={...req(),readOnly:false,disableNativeTools:false,localExecutionSessionId:'original-bot-chat'}
 const rejected=api.openChatStream(controlled,base,{enabled:true});await tick();assert.equal(starts,0)
 api.respondToApproval(approvals().at(-1).id,'reject');await assert.rejects(rejected,/not approved/);assert.equal(starts,0)
 const accepted=api.openChatStream(controlled,base,{enabled:true});await tick();api.respondToApproval(approvals().at(-1).id,'approve')
 for await(const _ of await accepted){}assert.equal(starts,1)
 const ctrl=new AbortController(),cancelled=api.openChatStream(controlled,{...base,signal:ctrl.signal},{enabled:true});await tick();ctrl.abort()
 await assert.rejects(cancelled,/not approved/);assert.equal(starts,1);assert.equal(api.pendingCount(),0)
})
test('legacy patterns keep literal semantics and cannot weaken the three local-mode outcomes',()=>{
 for(const mode of ['always-allow','ask-every-time','never-allow']){
  const settings={...state.settings,automaticReview:true,localExecutionPolicy:mode,allowlist:[]}
  const baseline=api.evaluate(settings,'shell','git status',new Set()).outcome
  assert.equal(api.evaluate({...settings,allowlist:['*']},'shell','git status',new Set()).outcome,baseline)
 }
 const natural={...state.settings,automaticReview:true,localExecutionPolicy:'always-allow',asklist:['Always ask before pushing code to a remote repository']}
 assert.equal(api.evaluate(natural,'shell','git push origin main',new Set()).outcome,'allow')
 assert.equal(api.evaluate({...natural,asklist:['git push *']},'shell','git push origin main',new Set()).outcome,'ask')
})

const clarificationRoot=process.env.BLINKY_CLARIFICATION_SOURCE_ROOT
for(const backendId of ['openai','codex'])test(`read-only counterpart clarification integration on ${backendId}`,{skip:!clarificationRoot},async()=>{
 reset()
 const {fixture,until}=await import(pathToFileURL(join(clarificationRoot,'src/main/tasks/controlFixture.mjs')).href)
 const f=await fixture()
 try{
  f.api.updateBot(f.bot.id,{backendId,modelId:'fixture',followsDefault:false})
  const source=f.api.getSession(f.home.id)
  f.api.saveSession({...source,messages:[...source.messages,{id:'objective',role:'user',content:'Create an internal report and choose ordinary reversible details.',createdAt:Date.now()}]})
  const t=await f.start('Create an internal report')
  // The counterpart's storage/turn harness remains unchanged. Its model stub
  // delegates to the real permission gateway and real API/CLI adapter here.
  f.state.answer={then(resolve,reject){const args=f.state.sideCalls.at(-1);api.runSideCall(...args).then(resolve,reject)}}
  const result=f.api.requestTaskClarification(t.sessionId,f.bot.id,[{id:'format',header:'Format',question:'Choose an internal report format',kind:'implementation'}],new AbortController().signal,'permission-integration')
  if(backendId==='openai'){
   let record;await until(async()=>{record=(await f.api.listTaskClarifications(t.id)).find(x=>x.status==='answered'||x.status==='waiting_user');return !!record})
   assert.equal(record.status,'answered',JSON.stringify({record,sideCalls:f.state.sideCalls.map(x=>({id:x[0],flags:{readOnly:x[1].readOnly,disableNativeTools:x[1].disableNativeTools}})),backend:f.api.getBot(f.bot.id),requests:state.requests}))
   assert.deepEqual(JSON.parse(JSON.stringify(await result)),{format:['Markdown']})
   assert.equal(record.answeredBy,'bot');assert.equal(record.answerBasis,'implementation')
   assert.equal(state.requests.length,1)
  }else{
   let record;await until(async()=>{record=(await f.api.listTaskClarifications(t.id)).find(x=>x.status==='waiting_user');return !!record})
   assert.equal(record.answeredBy,undefined);assert.equal(state.nativeAttempts,0)
   await f.api.cancelTaskClarification(record.id);assert.equal(await result,null)
  }
  assert.equal(f.state.sideCalls[0][1].disableNativeTools,true);assert.equal(f.state.sideCalls[0][1].readOnly,true)
  assert.equal(approvals().length,0)
 }finally{await f.close()}
})
