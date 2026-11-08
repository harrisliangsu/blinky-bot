import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks={
 './settingsGateway': `export const settingsStore={get:async()=>globalThis.__permissionTest.settings,append:(key,value)=>globalThis.__permissionTest.settings[key].push(value)}`,
 '../settings': `export const getSettings=()=>globalThis.__permissionTest.settings;export const onSettingsChanged=fn=>{globalThis.__permissionTest.listeners.push(fn);return()=>{globalThis.__permissionTest.listeners=globalThis.__permissionTest.listeners.filter(x=>x!==fn)}}`,
 './settings': `export const getSettings=()=>globalThis.__permissionTest.settings;export const onSettingsChanged=fn=>{globalThis.__permissionTest.listeners.push(fn);return()=>{globalThis.__permissionTest.listeners=globalThis.__permissionTest.listeners.filter(x=>x!==fn)}}`,
 './events': `export const broadcast=e=>globalThis.__permissionTest.events.push(e);export const broadcastError=()=>{}`,
 './cancel': `export const isRunning=()=>false;export const stopAfterRejectedApproval=()=>{}`,
 '../backends/vaultRedaction': `export const redactSecrets=x=>x`,
 './optionalModules': `export const loadBackendRegistry=async()=>({getBackend:()=>globalThis.__permissionTest.backend});export const tryCall=async(fn,fallback)=>fn?fn():fallback`
}
globalThis.__permissionTest={settings:{approvalPolicy:'auto-run',localExecutionPolicy:'ask-every-time',allowlist:[],denylist:[],asklist:[]},events:[],listeners:[]}
const bundled=await build({stdin:{contents:`export * from './approval.ts';export {openChatStream,runSideCall} from './backendGateway.ts';export {localOperationSignal,noteLocalPermissionSettings} from '../localExecution.ts'`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const api=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`)
const fixture=globalThis.__permissionTest
function settings(patch={}) {fixture.settings={...fixture.settings,...patch};api.noteLocalPermissionSettings(fixture.settings);for(const fn of [...fixture.listeners])fn(fixture.settings)}
function reset(){fixture.events.length=0;settings({approvalPolicy:'auto-run',localExecutionPolicy:'ask-every-time',automaticReview:true,allowlist:[],denylist:[],asklist:[]})}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const ask=(sessionId,signal,timeoutMs=1000)=>api.requestApproval({sessionId,toolName:'read_file',target:'fixture',kind:'fetch',summary:'Read fixture',detail:'Fixture',signal,timeoutMs})
const requests=()=>fixture.events.filter(e=>e.type==='approval-request').map(e=>e.request)

test('concurrent approvals, refusal, cancellation and stale replies stay isolated',async()=>{
 reset();const a=new AbortController(),b=new AbortController()
 const pa=ask('a',a.signal),pb=ask('b',b.signal);await tick();assert.equal(api.pendingCount(),2)
 const [ra,rb]=requests();assert.equal(ra.force,true);assert.equal(rb.force,true)
 assert.equal(api.respondToApproval(ra.id,'reject'),true);assert.equal((await pa).approved,false)
 assert.equal(api.pendingCount('b'),1);b.abort();assert.equal((await pb).approved,false)
 assert.equal(api.pendingCount(),0);assert.equal(api.respondToApproval(rb.id,'approve'),false)
 assert.equal(fixture.events.filter(e=>e.type==='approval-resolved').length,2)
})
test('timeout and policy revocation remove the card, and a saved allow-always answer cannot change rules',async()=>{
 reset();assert.equal((await ask('timeout',undefined,5)).approved,false)
 const p=ask('revoked');await tick();const r=requests().at(-1);settings({localExecutionPolicy:'never-allow'})
 assert.equal((await p).approved,false);assert.equal(api.respondToApproval(r.id,'approve'),false)
 reset();const once=ask('once');await tick();api.respondToApproval(requests().at(-1).id,'approve-always')
 assert.equal((await once).approved,true);assert.deepEqual(fixture.settings.allowlist,[])
 const next=ask('once');await tick();assert.equal(api.pendingCount('once'),1);api.cancelPending('once');await next
})
test('cancel after an answer and new deny rules revoke approval before the handler executes',async()=>{
 reset();const ctrl=new AbortController(),p=ask('cancel-race',ctrl.signal);await tick()
 api.respondToApproval(requests().at(-1).id,'approve');ctrl.abort();assert.equal((await p).approved,false)
 const q=ask('deny-race');await tick();api.respondToApproval(requests().at(-1).id,'approve');settings({denylist:['fixture']})
 assert.equal((await q).approved,false)
})
test('native CLI tasks never start on Never allow or rejection; every new task has a real approval',async()=>{
 reset();settings({allowlist:['tool:codex']});let starts=0
 const backend={id:'codex',label:'Codex',kind:'agent-cli',chat:async function*(req){starts++;if(req.signal.aborted)throw req.signal.reason;yield {type:'done'}}}
 const req={model:'fixture',messages:[{role:'user',content:'Local fixture task'}],signal:new AbortController().signal,localExecutionSessionId:'native',cwd:'/fixture'}
 await assert.rejects(api.openChatStream(backend,{...req,readOnly:true,localExecutionSessionId:undefined},{enabled:true}),/side call/);assert.equal(requests().length,0)
 const blocked=api.openChatStream(backend,req,{enabled:true});await tick();assert.equal(starts,0)
 api.respondToApproval(requests().at(-1).id,'reject');await assert.rejects(blocked,/not approved/);assert.equal(starts,0)
 const accepted=api.openChatStream(backend,req,{enabled:true});await tick();api.respondToApproval(requests().at(-1).id,'approve')
 for await(const chunk of await accepted)assert.equal(chunk.type,'done');assert.equal(starts,1)
 settings({localExecutionPolicy:'never-allow'});await assert.rejects(api.openChatStream(backend,req,{enabled:true}),/Never allow/);assert.equal(starts,1)
})
test('restrictive permission edits revoke a live operation while unrelated appearance edits do not',()=>{
 reset();settings({localExecutionPolicy:'always-allow'});const op=api.localOperationSignal(new AbortController().signal,fixture.settings)
 settings({theme:'dark'});assert.equal(op.signal.aborted,false)
 settings({denylist:['tool:shell']});assert.equal(op.signal.aborted,true);op.dispose()
})

test('clarification inference reports native CLI restrictions across all three policies, without bypass or orphan approval', async () => {
 const req={model:'fixture',messages:[{role:'user',content:'Resolve an Agent clarification'}],readOnly:true,disableNativeTools:true,signal:new AbortController().signal}
 for (const [policy,pattern,expectedStarts] of [
  ['ask-every-time',/side call requires a user decision/,0],
  ['never-allow',/Never allow/,0],
  ['always-allow',/cannot safely disable/,1]
 ]) {
  reset();settings({localExecutionPolicy:policy});let starts=0;const errors=[]
  fixture.backend={id:'codex',label:'Codex',kind:'agent-cli',chat:async function*(){starts++;throw new Error('Codex cannot safely disable its native host tools for this target')}}
  const result=await api.runSideCall('codex',req,fixture.settings,error=>errors.push(error.message))
  assert.equal(result,null);assert.equal(starts,expectedStarts);assert.match(errors[0],pattern)
  assert.equal(requests().length,0);assert.equal(api.pendingCount(),0)
 }
})

test('non-native Bot inference still operates without local resource permission and cannot turn model consent into approval',async()=>{
 for(const policy of ['always-allow','ask-every-time','never-allow']){
  reset();settings({localExecutionPolicy:policy});let starts=0
  fixture.backend={id:'cloud',label:'Cloud',kind:'cloud-api',chat:async function*(){starts++;yield {type:'text',delta:'{"answers":{"q":{"answer":"yes"}}}'};yield {type:'done'}}}
  const result=await api.runSideCall('cloud',{model:'fixture',messages:[{role:'user',content:'clarify'}],readOnly:true,disableNativeTools:true,signal:new AbortController().signal},fixture.settings)
  assert.equal(starts,1);assert.match(result.text,/yes/)
  const local=api.requestApproval({sessionId:policy,toolName:'read_file',target:'fixture',kind:'fetch',summary:'read',detail:result.text,localExecution:true})
  if(policy==='ask-every-time'){await tick();assert.equal(api.pendingCount(policy),1);api.cancelPending(policy)}
  assert.equal((await local).approved,policy==='always-allow')
 }
})

test('a revoked native stream cannot promote partial prose or a late done chunk to successful completion',async()=>{
 for(const lateDone of [false,true]){
  reset();settings({localExecutionPolicy:'always-allow'});let release
  const gate=new Promise(resolve=>release=resolve)
  const backend={id:'codex',label:'Codex',kind:'agent-cli',chat:async function*(){yield {type:'text',delta:'Partial work only'};await gate;if(lateDone)yield {type:'done'}}}
  const req={model:'fixture',messages:[{role:'user',content:'Synthetic workload'}],signal:new AbortController().signal,localExecutionSessionId:'native'}
  const stream=await api.openChatStream(backend,req,{enabled:true}),iterator=stream[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.delta,'Partial work only')
  settings({asklist:['tool:synthetic']});release()
  await assert.rejects(iterator.next(),error=>error.name==='AbortError')
 }
})
