/** Actual preload serialization, without Electron or any native window/process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const state=globalThis.__memoryRoutineApi={api:null,calls:[],reply:true}
const result=await build({entryPoints:[resolve('src/preload/index.ts')],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'no-electron',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}))
  b.onLoad({filter:/.*/,namespace:'mock'},()=>({loader:'js',contents:`const s=globalThis.__memoryRoutineApi;export const contextBridge={exposeInMainWorld:(_name,api)=>s.api=api};export const ipcRenderer={invoke:async(...a)=>{s.calls.push(a);return s.reply},on(){},removeListener(){}}`}))
}}]})
await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'))

test('legacy memory string and atomic edit objects traverse the real preload unchanged',async()=>{
  await state.api.bots.addMemory('bot','A local preference.')
  const request={text:'Corrected local preference.',replaceEntryId:'entry',requestId:'request',shared:true}
  await state.api.bots.addMemory('bot',request)
  assert.deepEqual(state.calls.slice(-2),[['openbot:bots:addMemory','bot','A local preference.'],['openbot:bots:addMemory','bot',request]])
})

test('removeMemory and routine run forward true and false acknowledgements, not void coercions',async()=>{
  for(const reply of [true,false]){
    state.reply=reply
    assert.equal(await state.api.bots.removeMemory('bot','entry'),reply)
    assert.equal(await state.api.routines.run('routine','home'),reply)
  }
  assert.deepEqual(state.calls.slice(-2),[['openbot:bots:removeMemory','bot','entry'],['openbot:routines:run','routine','home']])
})
test.after(()=>{delete globalThis.__memoryRoutineApi})
