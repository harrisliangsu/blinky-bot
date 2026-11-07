import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the actual removal IPC flow. OS/browser destruction, task admission,
// and disk storage are independent boundaries; their failures are injected.
const root = resolve(import.meta.dirname,'../../..'), temp = await mkdtemp(join(tmpdir(),'blinky-delete-ipc-'))
after(()=>rm(temp,{recursive:true,force:true}))
const fixture=join(temp,'fixture.mjs')
await writeFile(fixture,`export const state={}; export function reset(){Object.assign(state,{bot:{id:'bot',computerTarget:{kind:'local'}},calls:[],handlers:{},failure:null})} reset();
const hit=name=>state.calls.push(name);
export const getBot=()=>state.bot, listBots=()=>[], createBot=()=>null,duplicateBot=()=>null,updateBot=()=>null,setVmCapabilityProbe=()=>{};
export const retryBotRemoval=async()=>{};
export async function removeBotDurable(){hit('delete');if(state.failure==='disk')throw Error('disk failed');state.bot=null;return true}
export async function prepareBotTaskRemoval(){hit('fence');if(state.failure==='tasks')throw Error('stop failed');return()=>hit('release')}
export const allSessions=()=>[{id:'chat',botIds:['bot'],activeBotId:'bot',messages:[{content:'Retained history'}]}];
export function removeBotFromAllSessions(){hit('detach');return[{id:'chat',botIds:[],activeBotId:'',messages:[{content:'Retained history'}]}]}
export async function loopFn(){return state.failure==='runtime'?null:async()=>{hit('stop');if(state.failure==='stop')throw Error('stop failed')}}
export const listBotMemory=()=>[],deleteUserMemory=()=>false,saveUserMemory=()=>null;
export const removeBotFromProjects=()=>hit('projects'),removeBotFromGroups=()=>hit('groups'),removeRoutinesForBot=()=>hit('routines');
export const releaseComputerProvidersForBot=async()=>hit('providers'),removeBrowser=async(_id,options)=>{hit('browser');state.browserOptions=options},forgetReadyTakeover=()=>{};
export const dataRoot=()=>'/isolated',clearVmToken=()=>{},peekBrowserScopeMode=()=> 'session';
export const adoptAppleVm=()=>{},destroyAppleVm=async()=>hit('destroy-vm'),provisionalAppleVmToken=()=>null,asComputerTarget=x=>x,destroyVm=async()=>hit('destroy-vm'),probeTarget=async()=>({ok:true});
export const registerTakeoverIpc=()=>{},registerVmProvisionIpc=()=>{},registerBotResourcesIpc=()=>{};
export const broadcast=event=>{hit('broadcast');state.lastEvent=event};
export const CHANNELS=new Proxy({},{get:(_target,key)=>key}),emptyArray=()=>[],nullResult=()=>null;
export function handle(name,run,fallback){state.handlers[name]=async args=>{try{return await run(args)}catch(error){return fallback(args,error)}}} export const handleEvent=handle;
export const asId=x=>String(x),asPatch=x=>x,asString=x=>String(x);
`)
const entry = resolve(root,'src/main/ipc/bots.ts')
const built = await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'boundary-fixtures',setup(b){b.onResolve({filter:/.*/},a=>a.importer===entry?{path:fixture,external:true}:undefined)}}]
})
const output=join(temp,'ipc.mjs');await writeFile(output,built.outputFiles[0].text)
const {registerBotIpc}=await import(pathToFileURL(output).href)
const {state,reset}=await import(pathToFileURL(fixture).href)
const remove=async failure=>{reset();state.failure=failure;registerBotIpc();return state.handlers.botsRemove(['bot'])}

test('deleting a bot waits for task fencing and stop before detaching history',async()=>{
  assert.deepEqual(await remove(null),{ok:true})
  assert.deepEqual(state.calls,['fence','stop','providers','browser','delete','routines','groups','projects','detach','broadcast','release'])
  assert.equal(state.lastEvent.session.messages[0].content,'Retained history')
  assert.equal(state.browserOptions.deleteProfile,undefined)
})
test('deleting a VM Bot does not destroy its working computer or browser data',async()=>{
  reset();state.bot.computerTarget={kind:'vm',vmId:'retained-user-computer'};registerBotIpc()
  assert.deepEqual(await state.handlers.botsRemove(['bot']),{ok:true})
  assert.equal(state.calls.includes('destroy-vm'),false)
  assert.equal(state.browserOptions.deleteProfile,undefined)
  assert.equal(state.lastEvent.session.messages[0].content,'Retained history')
})
test('task cancellation failure refuses deletion without discarding configuration',async()=>{
  assert.equal((await remove('tasks')).ok,false)
  assert.deepEqual(state.calls,['fence']);assert.ok(state.bot)
})
test('stop or unavailable runtime refuses deletion and releases the admission fence',async()=>{
  for(const failure of ['stop','runtime']){
    assert.equal((await remove(failure)).ok,false)
    assert.equal(state.calls.at(-1),'release');assert.equal(state.calls.includes('delete'),false);assert.ok(state.bot)
  }
})
test('a persistence failure reports failure and leaves history attached',async()=>{
  assert.equal((await remove('disk')).ok,false)
  assert.equal(state.calls.includes('detach'),false);assert.equal(state.calls.at(-1),'release');assert.ok(state.bot)
  for(const mutation of ['routines','groups','projects']) assert.equal(state.calls.includes(mutation),false)
})
