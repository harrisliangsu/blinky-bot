import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const root=await mkdtemp(join(tmpdir(),'blinky-notification-preload-'))
const electron=join(root,'electron.mjs')
await writeFile(electron,`export const handlers=new Map();export const contextBridge={exposeInMainWorld:(name,api)=>globalThis.__testNotificationApi=api};export const ipcRenderer={invoke:async()=>undefined,on:(name,fn)=>{const set=handlers.get(name)??new Set();set.add(fn);handlers.set(name,set)},removeListener:(name,fn)=>handlers.get(name)?.delete(fn)};export function emit(name,value){for(const fn of handlers.get(name)??[])fn({},value)}`)
await build({entryPoints:['src/preload/index.ts'],outfile:join(root,'preload.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'isolated-electron-boundary',setup(b){b.onResolve({filter:/^electron$/},()=>({path:electron,external:true}))}}]})
const runtime=await import(electron);await import(join(root,'preload.mjs'))
const seen=[],api=globalThis.__testNotificationApi
runtime.emit('openbot:notification:open',{sessionId:'early',botId:'owner'})
assert.equal(seen.length,0)
const off=api.notifications.onOpen(target=>seen.push(target));await new Promise(queueMicrotask)
assert.deepEqual(seen,[{sessionId:'early',botId:'owner'}])
runtime.emit('openbot:notification:open',{sessionId:'live'});assert.equal(seen.at(-1).sessionId,'live');off()
runtime.emit('openbot:notification:open',{sessionId:'old'});runtime.emit('openbot:notification:open',{sessionId:'latest'})
const restored=[];api.notifications.onOpen(target=>restored.push(target));await new Promise(queueMicrotask)
assert.deepEqual(restored,[{sessionId:'latest'}]);assert.equal(seen.length,2)
console.log('PASS: notification activation waits for ready listener, arrives once, preserves ownership, unsubscribes and retains latest navigation')
