import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const bundle=await build({entryPoints:['src/main/tools/computer/browser/egoProvider.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'owned-ego-boundary',setup(b){
 b.onResolve({filter:/^(\.\/egoCli|\.\.\/localCapture|\.\.\/\.\.\/\.\.\/backends\/loginShellEnv)$/},a=>({path:a.path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='./egoCli'?`export const runEgoCommand=async script=>{globalThis.__egoOpen.scripts.push(script);const selector=JSON.parse(script.match(/taskSpace\\(([^)]*)\\)/)[1]);if(script.includes('id:task.spaceId'))return {id:globalThis.__egoOpen.id,name:typeof selector==='string'?selector:globalThis.__egoOpen.name};return globalThis.__egoOpen.id}`:a.path==='../localCapture'?'export const MAX_FRAME_WIDTH=1600':'export const hydratedEnv=async()=>({})',loader:'js'}))
}}]})
const {EgoComputerProvider}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
test('opening an Ego resource reuses the persisted ID and never claims any Space',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-owned-ego-'))
 try{
  globalThis.__egoOpen={id:321,scripts:[]}
  assert.equal(await new EgoComputerProvider('owned-bot',root).openForUser(),321)
  const record=JSON.parse(await readFile(join(root,'computers','owned-bot','ego-space.json'),'utf8'))
  globalThis.__egoOpen.name=record.name
  assert.equal(await new EgoComputerProvider('owned-bot',root).openForUser(),321)
  const scripts=globalThis.__egoOpen.scripts.join('\n')
  assert.match(scripts,/taskSpace\(321\)/);assert.match(scripts,/space ownership mismatch/);assert.match(scripts,/Target.activateTarget/)
  assert.doesNotMatch(scripts,/claimTaskSpace|takeOverTaskSpace|listTaskSpaces|finish\(/)
  globalThis.__egoOpen.id=999
  await assert.rejects(new EgoComputerProvider('owned-bot',root).openForUser(),/does not match/)
  assert.equal(JSON.parse(await readFile(join(root,'computers','owned-bot','ego-space.json'),'utf8')).id,321)
 }finally{await rm(root,{recursive:true,force:true})}
})
