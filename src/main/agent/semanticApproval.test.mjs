/** Real gate/reviewer/handler; only the model and owning storage are synthetic. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {dirname,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=await mkdtemp(join(tmpdir(),'blinky-semantic-review-'))
const state={settings:{},events:[],calls:[],response:null,wait:null,listeners:[],available:true}
globalThis.__semanticApproval=state
const mocks={
 '../settings':`export const onSettingsChanged=fn=>{globalThis.__semanticApproval.listeners.push(fn);return()=>{}}`,
 './settingsGateway':`export const settingsStore={get:async()=>globalThis.__semanticApproval.settings,append(){throw Error('No silent rule migration')}}`,
 './events':`export const broadcast=e=>globalThis.__semanticApproval.events.push(e);export const broadcastError=()=>{}`,
 './cancel':`export const isRunning=()=>false;export const stopAfterRejectedApproval=()=>{}`,
 '../store/sessions':`export const getSession=id=>id==='owner-chat'?{id,botIds:['owner'],cwd:'/synthetic'}:null`,
 '../store/bots':`export const getBot=()=>({id:'owner',backendId:'owner-provider',modelId:'owner-model',followsDefault:false})`,
 '../store/vaultPrivacy':`export const scrubVaultJson=x=>x`,
 '../backends/vaultRedaction':`export const redactSecrets=x=>x`,
 './backendGateway':`export const getBackend=async()=>globalThis.__semanticApproval.available?{id:'owner-provider',kind:'cloud-api'}:null;export async function runSideCall(...args){const s=globalThis.__semanticApproval;s.calls.push(args);if(s.wait)await s.wait;return s.response}`
}
const out=await build({stdin:{contents:`export {requestApproval,respondToApproval,cancelPending,pendingCount} from './approval.ts';export {semanticVerdict} from './semanticApprovalPolicy.ts';export {defineTool} from '../tools/results.ts';export {noteLocalPermissionSettings} from '../localExecution.ts'`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'synthetic-model',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
await writeFile(join(root,'api.mjs'),out.outputFiles[0].contents);const api=await import(pathToFileURL(join(root,'api.mjs')).href)
const allow={id:'allow-read',version:1,effect:'allow',text:'无需询问即可查看本次报告的文件内容'}
const ask={id:'ask-push',version:1,effect:'ask',text:'向远端仓库发布代码前询问我'}
const reply=(matches,review='ask')=>({text:JSON.stringify({matches,review,reason:'Synthetic semantic decision'}),calls:[]})
const match=(id,result='no',evidence='')=>({id,match:result,evidence})
const approvals=()=>state.events.filter(e=>e.type==='approval-request').map(e=>e.request)
function reset(patch={}){state.settings={approvalPolicy:'auto-run',localExecutionPolicy:'always-allow',automaticReview:true,allowlist:[],denylist:[],asklist:[],semanticPermissionRules:[allow,ask],defaultBackendId:'owner-provider',defaultModelId:'owner-model',backends:{'owner-provider':{enabled:true}},...patch};state.events=[];state.calls=[];state.available=true;state.wait=null;state.response=reply([match(allow.id),match(ask.id)])}
const until=async f=>{for(let i=0;i<500;i++){if(f())return;await new Promise(r=>setTimeout(r,2))}throw Error('Timed out')}
const request=(patch={})=>api.requestApproval({sessionId:'owner-chat',botId:'owner',toolName:'shell',target:'git status',kind:'shell',summary:'Inspect repository state',detail:'git status',timeoutMs:1000,...patch})
async function human(p,decision='reject'){await until(()=>approvals().length>0);api.respondToApproval(approvals().at(-1).id,decision);return p}
test('semantic ask catches a paraphrased publishing action; ask wins over a matching allow',async()=>{
 reset();state.response=reply([match(allow.id,'yes','git push'),match(ask.id,'yes','git push')],'safe')
 const p=request({target:'git push origin main',detail:'publish using git push origin main'});const result=await human(p)
 assert.equal(result.approved,false);assert.equal(state.calls.length,1);assert.match(approvals()[0].detail,/always ask semantic/);assert.equal(approvals()[0].force,true)
 const [,req]=state.calls[0];assert.equal(req.model,'owner-model');assert.equal(req.readOnly,true);assert.equal(req.disableNativeTools,true);assert.equal(req.tools,undefined);assert.equal(req.mcpServers,undefined)
})
test('allow has an observable effect on a soft review, inside Always allow; no allow requires a real decision',async()=>{
 reset();const p=request();assert.equal((await human(p)).approved,false)
 reset();state.response=reply([match(allow.id,'yes','git status'),match(ask.id)])
 assert.equal((await request()).approved,true);assert.equal(approvals().length,0)
 reset({allowlist:['git status']});assert.equal((await request()).approved,true);assert.equal(state.calls.length,1);assert.equal(approvals().length,0)
})
test('strict local modes, denies, explicit ask, automatic review off and mandatory confirmation never consult the model or honor a semantic allow',async()=>{
 for(const patch of [{localExecutionPolicy:'ask-every-time',allowlist:['*']},{automaticReview:false},{asklist:['git status']}]){
  reset(patch);state.response=reply([match(allow.id,'yes','git status'),match(ask.id)])
  assert.equal((await human(request())).approved,false);assert.equal(state.calls.length,0)
 }
 for(const patch of [{localExecutionPolicy:'never-allow'},{denylist:['*']}]){reset(patch);assert.equal((await request()).approved,false);assert.equal(approvals().length,0);assert.equal(state.calls.length,0)}
 reset();await human(request({force:true}));assert.equal(state.calls.length,0)
})
test('unavailable, uncertain, fabricated, partial or malformed semantic judgments all ask a human',async()=>{
 const cases=[null,{text:'not JSON',calls:[]},reply([match(allow.id,'uncertain'),match(ask.id)]),reply([match(allow.id,'yes','invented unseen contents'),match(ask.id)]),reply([match(allow.id)]),reply([match(allow.id,'yes','git status'),match(ask.id)],'uncertain')]
 for(const response of cases){reset();state.response=response;assert.equal((await human(request())).approved,false)}
 reset();state.available=false;assert.equal((await human(request())).approved,false);assert.equal(state.calls.length,0)
 reset();assert.equal((await human(request({sessionId:'missing'}))).approved,false);assert.equal(state.calls.length,0)
})
test('cancellation and rule edits during review cannot auto-authorize; late model answers are not cached',async()=>{
 reset();let release;state.wait=new Promise(r=>release=r);state.response=reply([match(allow.id,'yes','git status'),match(ask.id)])
 const ctrl=new AbortController(),p=request({signal:ctrl.signal});await until(()=>state.calls.length===1);ctrl.abort();assert.equal((await p).approved,false);assert.equal(approvals().length,0);release()
 reset();state.wait=new Promise(r=>release=r);state.response=reply([match(allow.id,'yes','git status'),match(ask.id)])
 const q=request();await until(()=>state.calls.length===1);state.settings={...state.settings,semanticPermissionRules:[ask]};release();assert.equal((await human(q)).approved,false)
})
test('a real file read remains unexecuted before approval; an allowed semantic decision then reads only that synthetic file',async()=>{
 const file=join(root,'report.txt');await writeFile(file,'synthetic report')
 const tool=api.defineTool({name:'read_file',description:'Read synthetic fixture',parameters:{}},async(args,ctx)=>({callId:ctx.callId,name:'read_file',ok:true,output:await readFile(args.path,'utf8')}))
 const context=()=>({sessionId:'owner-chat',botId:'owner',cwd:root,signal:new AbortController().signal,settings:state.settings,getSettings:()=>state.settings,requestApproval:draft=>api.requestApproval({...draft,botId:'owner',target:file,localExecution:true}).then(r=>r.approved)})
 reset();const p=tool.handler({path:file},context());await until(()=>approvals().length===1);api.respondToApproval(approvals()[0].id,'reject');assert.equal((await p).ok,false)
 reset();state.response=reply([match(allow.id,'yes',file),match(ask.id)])
 assert.equal((await tool.handler({path:file},context())).output,'synthetic report');assert.equal(approvals().length,0)
 reset({localExecutionPolicy:'ask-every-time',allowlist:['*']});const q=tool.handler({path:file},context());await until(()=>approvals().length===1);api.respondToApproval(approvals()[0].id,'approve');assert.equal((await q).output,'synthetic report');assert.equal(state.calls.length,0)
})
process.once('beforeExit',()=>rm(root,{recursive:true,force:true}))
