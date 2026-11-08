import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const file=resolve('src/main/agent/turnDriver.ts'), original=await readFile(file,'utf8')
const mocks={
 './sessionGateway':`export const bots={many:async()=>globalThis.__leadRace.bots,get:async id=>globalThis.__leadRace.bots.find(b=>b.id===id)};export const sessions={refresh:async s=>{await Promise.resolve();Object.assign(s,globalThis.__leadRace.latest)},update:async(s,fn)=>fn(s)}`,
 './limits':`export const takeIteration=()=>true;export const iterationCapMessage=()=>'';export const handoffsLeft=()=>1;export const clearHandoffs=()=>{}`,
 './exchangeBrief':`export const actionNudge=()=>'';export const floorBrief=()=>'';export const goalOf=()=>'';export const lastUserMessage=()=>''`,
 './exchange':`export const addressedBot=()=>null;export const mentionsBot=()=>false`,
 './messages':`export const addNotice=async()=>{}`,
 './mcpGateway':`export const cancelGatewayDetach=()=>{};export const detachGateway=()=>{};export const scheduleGatewayDetach=()=>{}`,
 './events':`export const broadcastError=(_id,msg)=>globalThis.__leadRace.errors.push(msg)`,
 './memory':`export const enqueueMemoryExtraction=async()=>{}`,
 './backendGateway':`export const getBackendInfo=async()=>({kind:'api'})`,
 './quickDecision':`export const quickDecisionHint=async()=>{globalThis.__leadRace.quickDecisionCalls++;return globalThis.__leadRace.hint??null}`,
 './turn':`export const runTurn=async input=>{globalThis.__leadRace.executed.push(input.bot.id);globalThis.__leadRace.lastInput=input;return {status:'final',message:{id:'reply',content:'assessment'}}}`,
 './supervisedTurn':`export const runSupervisedTurn=async()=>{throw Error('No CLI in this deterministic race fixture')}`,
 '../store/bots':`export const applyBotBinding=bot=>bot;export const getBot=id=>globalThis.__leadRace.bots.find(b=>b.id===id)`,
 '../store/sessions':`export const getSession=()=>globalThis.__leadRace.latest`,
 './settingsGateway':`export const settingsStore={get:async()=>globalThis.__leadRace.settings??{}}`,
 './executionAgent':`export const bindExecutionAgent=(_s,bot)=>bot;export const isExecutionAgent=()=>false;export const backgroundBotOwner=()=>undefined`
}
async function compile(source){const result=await build({stdin:{contents:source,resolveDir:dirname(file),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'race-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)}
const actual=await compile(original)
await mkdir(resolve('docs/test-evidence'),{recursive:true})
function fixture(removed=false){globalThis.__leadRace={bots:[{id:'a',name:'Lead A',backendId:'api',computerTarget:{kind:'local'}},{id:'b',name:'Bot B',backendId:'api',computerTarget:{kind:'local'}}],latest:{id:'home',activeBotId:'b',botIds:removed?['b']:['a','b']},executed:[],errors:[],quickDecisionCalls:0};return {id:'home',activeBotId:'a',botIds:['a','b'],messages:[]}}
test('actual driver pins the original lead after async Bot selection changes, without changing UI selection',async()=>{
 let s=fixture();await actual.iterate(s,new AbortController().signal,{internalAssistant:true,reviewBotId:'a'});assert.deepEqual(globalThis.__leadRace.executed,['a']);assert.equal(s.activeBotId,'b')
 s=fixture(true);await actual.iterate(s,new AbortController().signal,{internalAssistant:true,reviewBotId:'a'});assert.deepEqual(globalThis.__leadRace.executed,[])
 s=fixture();await actual.iterate(s,new AbortController().signal,{internalAssistant:true});assert.deepEqual(globalThis.__leadRace.executed,['b'])
 await writeFile(resolve('docs/test-evidence/intelligence-lead-race.json'),JSON.stringify({integrated:true,originalLeadExecuted:'a',uiSelectionRemains:'b',removedLeadDoesNotRun:true,ordinaryChatUsesSelectedBot:true},null,2))
})
test('actual execution gate rejects false/abort and marks a start only immediately before the executor',async()=>{
 const channel=()=>{const s=fixture();s.botIds=['a'];globalThis.__leadRace.latest={id:'home',activeBotId:'a',botIds:['a']};return s}
 let called=0,started=0,s=channel()
 await actual.iterate(s,new AbortController().signal,{targetBotId:'a',beforeFirstTurn:async()=>{called++;return false},onExecutionStart:()=>started++})
 assert.equal(called,1);assert.equal(started,0);assert.deepEqual(globalThis.__leadRace.executed,[])
 s=channel()
 await actual.iterate(s,new AbortController().signal,{targetBotId:'a',beforeFirstTurn:async()=>{called++;return true},onExecutionStart:()=>started++})
 assert.equal(called,2);assert.equal(started,1);assert.deepEqual(globalThis.__leadRace.executed,['a'])
 const controller=new AbortController();s=channel()
 await actual.iterate(s,controller.signal,{targetBotId:'a',beforeFirstTurn:async()=>{controller.abort();return true},onExecutionStart:()=>started++})
 assert.equal(started,1);assert.deepEqual(globalThis.__leadRace.executed,[])
 s=channel();await actual.iterate(s,new AbortController().signal,{targetBotId:'a'})
 assert.deepEqual(globalThis.__leadRace.executed,['a'])
 await writeFile(resolve('docs/test-evidence/intelligence-webhook-start-gate.json'),JSON.stringify({integrated:true,callbackBeforeActualTurn:true,falseDoesNotExecute:true,abortDoesNotExecute:true,ordinaryChatUnchanged:true},null,2))
})
test('retired quickDecision settings never invoke hidden routing or replace the chosen Bot model',async()=>{
 const s=fixture();s.mode='agent';s.botIds=['a'];globalThis.__leadRace.latest={id:'home',activeBotId:'a',botIds:['a'],mode:'agent'}
 Object.assign(globalThis.__leadRace.bots[0],{modelId:'frozen-lead-model',thinking:'high'})
 globalThis.__leadRace.bots=globalThis.__leadRace.bots.slice(0,1)
 globalThis.__leadRace.settings={quickDecision:{backendId:'advice',modelId:'small'}}
 globalThis.__leadRace.hint={route:'delegate',reason:'Several implementation steps remain'}
 await actual.iterate(s,new AbortController().signal)
 assert.deepEqual(globalThis.__leadRace.executed,['a'])
 assert.equal(globalThis.__leadRace.lastInput.bot.modelId,'frozen-lead-model')
 assert.equal(globalThis.__leadRace.lastInput.bot.thinking,'high')
 assert.equal(globalThis.__leadRace.quickDecisionCalls,0)
 assert.doesNotMatch(JSON.stringify(globalThis.__leadRace.lastInput.extras),/Routing advice is optional|quick_decision/)
 assert.deepEqual(globalThis.__leadRace.settings.quickDecision,{backendId:'advice',modelId:'small'})
})
