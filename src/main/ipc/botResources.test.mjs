import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const root=await mkdtemp(join(tmpdir(),'blinky-resource-test-'))
const mocks={
 electron:`export const app={getPath:()=>globalThis.__resources.root};export const shell={openPath:async p=>{globalThis.__resources.opened.push(p);return ''}}`,
 '../store/bots':`export const getBot=id=>id==='bot'?{id,archived:false}:null`,
 '../store/sessions':`export const getSession=id=>id==='source'?{id,botIds:['bot'],cwd:globalThis.__resources.root}:id==='foreign'?{id,botIds:['other'],cwd:globalThis.__resources.root}:null`,
 '../store/paths':`export const dataRoot=()=>globalThis.__resources.root`,
 '../tools/computer':`import {EgoComputerProvider} from 'mock-ego';export const getComputerProvider=(target,options)=>{globalThis.__resources.providers.push({target,options});return new EgoComputerProvider()}`,
 '../tools/computer/browser/egoProvider':`export class EgoComputerProvider{async openForUser(){return 123}}`,
 'mock-ego':`export class EgoComputerProvider{async openForUser(){return 123}}`,
 './handler':'export const handle=()=>{}'
}
const bundle=await build({entryPoints:['src/main/ipc/botResources.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'resources-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path==='mock-ego'?'../tools/computer/browser/egoProvider':a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
const {openBotResource}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
test('resource opener validates owner/session and opens only the selected resource',async()=>{
 globalThis.__resources={root,opened:[],providers:[]}
 try{
  await assert.rejects(openBotResource('bot','foreign','browser'),/unavailable/)
  await assert.rejects(openBotResource('other','source','computer'),/unavailable/)
  await assert.rejects(openBotResource('bot','source','invalid'),/Unknown/)
  assert.deepEqual(globalThis.__resources.opened,[]);assert.deepEqual(globalThis.__resources.providers,[])
  assert.deepEqual(await openBotResource('bot','source','computer'),{ok:true});assert.deepEqual(globalThis.__resources.opened,[root])
  assert.deepEqual(await openBotResource('bot','source','browser'),{ok:true,spaceId:123})
  assert.deepEqual(globalThis.__resources.providers,[{target:{kind:'browser',botId:'bot',provider:'ego'},options:{botId:'bot',sessionId:'source',dataDir:root}}])
 }finally{await rm(root,{recursive:true,force:true})}
})
