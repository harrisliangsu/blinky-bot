import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Real MCP dispatcher + real action classifier; replace transport and handlers.
const mocks = {
  '../agent/approval': `export const requestApproval=async input=>{globalThis.__taskGate.approvals.push(input);return {approved:globalThis.__taskGate.approved,reason:'synthetic rejection'}}`,
  '../agent/settingsGateway': `export const settingsStore={get:async()=>({denylist:[],asklist:[]})}`,
  '../agent/events': 'export const broadcast=()=>{}',
  '../agent/toolContext': 'export const SELF_APPROVING=new Set()',
  '../tools/computer': 'export const getComputerProvider=()=>({})',
  '../tools/computer/gate': 'export const captureFrame=async()=>({})',
  '../store/paths': 'export const dataRoot=()=>"/synthetic"',
  '../store/bots': 'export const getBot=()=>({id:"bot",tools:["manage_task"],computerUse:false})',
  '../store/sessions': 'export const getSession=()=>({id:"source",botIds:["bot"]})',
  '../agent/executionAgent': 'export const bindExecutionAgent=(_id,bot)=>bot;export const isCodexCoordinator=()=>false',
  '../settings': 'export const getSettings=()=>({})',
  './descriptors': `export const sessionMode=()=>globalThis.__taskGate.mode;export const exposedSchema=()=>({name:'manage_task',mutating:false});export const describeTools=()=>[{name:'ask_user'},{name:'decision_review'}]`,
  './tokens': 'export const assignMcpSessionId=()=>{}',
  './host': 'export const gatewayHost={}',
  '../tools/registry': `export const runTool=async(call,ctx)=>{const f=globalThis.__taskGate;f.handlers.push(call.args.action);if(call.args.action==='resume'){const ok=await ctx.requestApproval({id:'recovery',toolName:'manage_task',kind:'write',force:true,summary:'Fresh recovery',detail:'synthetic'});if(!ok)return {callId:call.id,name:call.name,ok:false,output:'Recovery refused'}}return {callId:call.id,name:call.name,ok:true,output:'ran'}}`
}
const compiled=await build({stdin:{contents:"export {invokeTool} from './invoke.ts';export {dispatch} from './protocol.ts';export {beginTaskJudgment} from '../agent/taskJudgmentScope.ts'",resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'transport-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'))
test('MCP task actions honor ordinary approval, mode and private judgment without weakening recovery', async()=>{
 const state=globalThis.__taskGate={mode:'agent',approved:false,approvals:[],handlers:[]}
 const grant={sessionId:'source',botId:'bot',tools:['manage_task'],computerUse:false,abort:new AbortController(),cwd:'/synthetic'}
 const call=action=>api.invokeTool(grant,'manage_task',{action,task_id:'task'},new AbortController().signal)
 for(const action of ['list','inspect','match'])assert.ok(!(await call(action)).isError)
 assert.equal(state.approvals.length,0)
 for(const action of ['message','stop','report','prioritize','describe','unknown'])assert.equal((await call(action)).isError,true)
 assert.equal(state.handlers.length,3)
 assert.deepEqual(state.approvals.map(value=>value.call.args.action),['message','stop','report','prioritize','describe','unknown'])
 await call('resume');assert.equal(state.approvals.at(-1).force,true);assert.equal(state.approvals.filter(a=>a.call.args.action==='resume').length,1)
 state.approved=true;assert.ok(!(await call('describe')).isError)
 for(const mode of ['ask','plan']){state.mode=mode;const before=state.handlers.length;for(const action of ['message','describe','resume'])assert.equal((await call(action)).isError,true);assert.equal(state.handlers.length,before)}
 state.mode='agent';const release=api.beginTaskJudgment('source','task','bot')
 try{assert.deepEqual((await api.dispatch(grant,{jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools,[]);const before=state.approvals.length;for(const action of ['message','describe','resume'])assert.equal((await call(action)).isError,true);assert.equal(state.approvals.length,before);assert.ok(!(await call('inspect')).isError)}finally{release();delete globalThis.__taskGate}
})
