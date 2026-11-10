import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = {
  'electron': `export const BrowserWindow={fromWebContents:s=>s.owned?{}:null};export const ipcMain={removeHandler:()=>{},handle:(channel,fn)=>globalThis.__intentIpc.renderer.set(channel,fn)}`,
  '../native/stdioBridge': 'export const registerNativeHandler=(channel,fn)=>globalThis.__intentIpc.native.set(channel,fn)',
  './broadcast': 'export const broadcast=e=>globalThis.__intentIpc.events.push(e)',
  '../store/sessions': 'export const getSession=()=>globalThis.__intentIpc.session',
  './agentRuntime': 'export const AGENT_UNAVAILABLE="unavailable";export const loopFn=async name=>name==="sendMessage"?async()=>{globalThis.__intentIpc.modelCalls++}:async()=>{}',
  '../tools/agent/help': 'export const returnHumanControl=()=>false',
  '../store/messageQueue': 'export const getMessageQueue=()=>globalThis.__intentIpc.queue;export const enqueueMessage=async(id,text,attachments)=>{globalThis.__intentIpc.enqueued++;globalThis.__intentIpc.queue.items.push({id:"queued",text,attachments,createdAt:1,status:"waiting"});return globalThis.__intentIpc.queue};export const pauseQueueIfNeeded=async()=>{};export const setQueuePaused=async()=>{}',
  '../agent/messageQueueRuntime': 'export const announceQueue=()=>{};export const drainQueue=async()=>{};export const isQueueDraining=()=>globalThis.__intentIpc.draining;export const isQueueSuspended=()=>false;export const queueSuspensionGeneration=()=>0;export const removeQueuedItem=async()=>{};export const suspendQueue=()=>{};export const unsuspendQueue=()=>{}',
  '../agent/cancel': 'export const isRunning=()=>globalThis.__intentIpc.running',
  '../tasks': 'export const cancelBackgroundTask=async()=>{}',
  '../store/tasks': 'export const listTasks=()=>[]',
  '../agent/startReservation': 'export const beginQueueWrite=()=>{};export const cancelStart=()=>{};export const endQueueWrite=()=>{};export const hasPendingQueueWrite=()=>false;export const isStartCancelled=()=>false;export const isStarting=()=>globalThis.__intentIpc.starting;export const releaseStart=()=>{};export const reserveStart=()=>{}',
  '../backends/cli/codexAppServer': 'export const steerCodexTurn=async()=>false',
  '../agent/sessionGateway': 'export const sessions={get:async()=>globalThis.__intentIpc.session}',
  '../agent/messages': 'export const addNotice=async()=>{};export const addUserMessage=async()=>{}',
  '../settings': 'export const getSettings=()=>({language:"en"})',
  '../store/bots': 'export const getBot=()=>({id:"bot"})',
  '../agent/memoryPreferences': 'export const captureUserPreference=async()=>{}',
  '../agent/liveMessages': 'export const liveMessages=()=>[]',
  '../backends/chatTiming': 'export const traceChatTiming=()=>{}',
  '../agent/gmailUserIntent': 'export const consumeGmailUserIntent=async(...args)=>{globalThis.__intentIpc.consumeCalls.push(args);return globalThis.__intentIpc.consumeResult}'
}
const built=await build({stdin:{contents:"export {registerAgentIpc} from './agent.ts'",resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'desktop-and-provider-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const {registerAgentIpc}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`)
function fixture(){const state={renderer:new Map(),native:new Map(),events:[],consumeCalls:[],consumeResult:{consumed:true,accepted:true},modelCalls:0,enqueued:0,running:false,starting:false,draining:false,session:{id:'source',activeBotId:'bot',botIds:['bot'],mode:'agent',messages:[]},queue:{sessionId:'source',paused:false,items:[]}};globalThis.__intentIpc=state;registerAgentIpc();return state}
const event=(owned=true,frame=1)=>({sender:{id:7,owned,mainFrame:{frameTreeNodeId:1}},senderFrame:{frameTreeNodeId:frame}})

test('only the trusted main-frame renderer can interpret Gmail intent',async()=>{
 const s=fixture(),send=s.renderer.get('openbot:agent:send')
 assert.equal(await send(event(false),'source','发送',[]),false)
 assert.equal(await send(event(true,2),'source','发送',[]),false)
 assert.equal(s.consumeCalls.length,0);assert.equal(s.modelCalls,0)
 assert.equal(await send(event(),'source','发送',[]),true)
 assert.equal(s.consumeCalls.length,1);assert.equal(s.consumeCalls[0][0],7)
 assert.equal(s.modelCalls,0);assert.equal(s.events.filter(e=>e.type==='done').length,1)
})
test('consumed enqueue stays outside the model queue and never clears another live run',async()=>{
 const s=fixture(),enqueue=s.renderer.get('openbot:agent:enqueue');s.running=true
 assert.equal((await enqueue(event(),'source','发送这封草稿',[])).sessionId,'source')
 assert.equal(s.enqueued,0);assert.equal(s.events.some(e=>e.type==='done'),false)
 s.running=false;s.starting=true;await enqueue(event(),'source','发送',[])
 assert.equal(s.events.some(e=>e.type==='done'),false)
 s.starting=false;s.draining=true;await enqueue(event(),'source','发送',[])
 assert.equal(s.events.some(e=>e.type==='done'),false)
})
test('native stdio send/enqueue preserve their original behavior without Gmail authorization',async()=>{
 const s=fixture()
 assert.equal(await s.native.get('openbot:agent:send')(['source','发送',[]]),true)
 assert.equal(s.modelCalls,1);assert.equal(s.consumeCalls.length,0)
 assert.equal((await s.native.get('openbot:agent:enqueue')(['source','发送',[]])).items.length,1)
 assert.equal(s.enqueued,1);assert.equal(s.consumeCalls.length,0)
})
test('ordinary renderer text keeps existing model/queue behavior, while failed local persistence never falls through',async()=>{
 const s=fixture();s.consumeResult={consumed:false,accepted:false}
 assert.equal(await s.renderer.get('openbot:agent:send')(event(),'source','ordinary',[]),true)
 assert.equal(s.modelCalls,1)
 await s.renderer.get('openbot:agent:enqueue')(event(),'source','ordinary',[])
 assert.equal(s.enqueued,1)
 s.consumeResult={consumed:true,accepted:false};s.running=true
 assert.equal(await s.renderer.get('openbot:agent:send')(event(),'source','发送',[]),false)
 assert.equal(s.modelCalls,1);assert.equal(s.events.some(e=>e.type==='done'),false)
})
