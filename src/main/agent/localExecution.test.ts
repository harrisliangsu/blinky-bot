import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, normaliseSettings } from '../settingsSchema.ts'
import { evaluate } from './approvalPolicy.ts'
import { readFileTool } from '../tools/fs/readFile.ts'
import { writeFileTool } from '../tools/fs/writeFile.ts'
import { editFileTool } from '../tools/fs/editFile.ts'
import { shellTool } from '../tools/shell/index.ts'
import { noteLocalPermissionSettings } from '../localExecution.ts'
import type { ToolContext } from '../tools/types.ts'

test('never refuses a local read before the handler reads a file', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-unit-'))
 try {
  await writeFile(join(root,'fixture.txt'),'LOCAL_PRIVATE_FIXTURE')
  let prompts=0
  const ctx:ToolContext={sessionId:'test',botId:'test',cwd:root,signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),localExecutionPolicy:'never-allow'},requestApproval:async()=>{prompts++;return true}}
  const result=await readFileTool.handler({path:'fixture.txt'},ctx)
  assert.equal(result.ok,false); assert.ok(!result.output.includes('LOCAL_PRIVATE_FIXTURE'));assert.equal(prompts,0)
 } finally {await rm(root,{recursive:true,force:true})}
})
test('every time requires approval even for contained reads and allowlisted safe shell', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-unit-'))
 try {
  await writeFile(join(root,'fixture.txt'),'fixture')
  let prompts=0
  const ctx:ToolContext={sessionId:'test',botId:'test',cwd:root,signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),allowlist:['*'],localExecutionPolicy:'ask-every-time'},requestApproval:async()=>{prompts++;return false}}
  assert.equal((await readFileTool.handler({path:'fixture.txt'},ctx)).ok,false)
  assert.equal((await shellTool.handler({command:'pwd'},ctx)).ok,false)
  assert.equal(prompts,2)
 } finally {await rm(root,{recursive:true,force:true})}
})
test('local policy supersedes remembered grants without changing legacy rules', () => {
 const s={...defaultSettings(),allowlist:['*'],localExecutionPolicy:'ask-every-time' as const}
 assert.equal(evaluate(s,'read_file','fixture',new Set(['read_file::fixture'])).outcome,'ask')
 assert.equal(evaluate({...s,localExecutionPolicy:'never-allow'},'shell','pwd',new Set(),true).outcome,'deny')
})


test('migration retains the original policy, instructions and hard denials without widening access', () => {
 for(const legacy of ['auto-run','ask-first-time','ask-every-time','allowlist'] as const){
  const input={approvalPolicy:legacy,allowlist:['git status *'],denylist:['/private/fixture-secret'],rules:'retained instructions'}
  const normalized=normaliseSettings(input)
  assert.equal(normalized.approvalPolicy,legacy)
  assert.equal(normalized.localExecutionPolicy,legacy==='auto-run'?'always-allow':'ask-every-time')
  assert.deepEqual(normalized.allowlist,input.allowlist); assert.deepEqual(normalized.denylist,input.denylist)
  assert.equal(normalized.rules,input.rules)
  assert.deepEqual(normaliseSettings(JSON.parse(JSON.stringify(normalized))),normalized)
 }
 assert.equal(normaliseSettings({localExecutionPolicy:'invalid'}).localExecutionPolicy,'ask-every-time')
 assert.equal(normaliseSettings({localExecutionPolicy:'never-allow',approvalPolicy:'auto-run'}).localExecutionPolicy,'never-allow')
})
test('every-time mode overrides saved allows; legacy non-local allow rules retain their effect', () => {
 const base={...defaultSettings(),localExecutionPolicy:'ask-every-time' as const,allowlist:['tool:read_file']}
 assert.equal(evaluate(base,'read_file','fixture.txt',new Set()).outcome,'ask')
 assert.equal(evaluate({...base,approvalPolicy:'ask-every-time',allowlist:['tool:fetch']},'fetch','https://fixture.test/',new Set()).outcome,'allow')
 assert.equal(evaluate({...base,approvalPolicy:'ask-every-time',allowlist:[]},'fetch','https://fixture.test/',new Set()).outcome,'ask')
 assert.equal(evaluate({...base,asklist:['tool:read_file']},'read_file','fixture.txt',new Set()).outcome,'ask')
 assert.equal(evaluate({...base,denylist:['fixture.txt']},'read_file','fixture.txt',new Set()).outcome,'deny')
 assert.equal(evaluate({...base,localExecutionPolicy:'never-allow'},'read_file','fixture.txt',new Set()).outcome,'deny')
 assert.equal(evaluate({...base,automaticReview:false},'read_file','fixture.txt',new Set()).outcome,'ask')
 assert.equal(evaluate(base,'read_file','fixture.txt',new Set(),true).outcome,'ask')
 const call={id:'test',name:'shell',args:{command:'pwd',cwd:'/sensitive/nested'}}
 assert.equal(evaluate({...base,asklist:['/sensitive/*']},'shell','pwd',new Set(),false,false,true,call).outcome,'ask')
})
test('one allowed cross-directory read does not grant another read or bypass a later refusal', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-unit-'))
 try {
  await writeFile(join(root,'one.txt'),'one')
  const ctx:ToolContext={sessionId:'cross',botId:'test',cwd:join(root,'workspace'),signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),localExecutionPolicy:'ask-every-time'},requestApproval:async()=>true}
  const first=await readFileTool.handler({path:join(root,'one.txt')},ctx)
  assert.equal(first.ok,true)
  let asks=0
  const denied=await readFileTool.handler({path:join(root,'one.txt')},{...ctx,requestApproval:async()=>{asks++;return false}})
  assert.equal(denied.ok,false); assert.equal(asks,1)
 } finally {await rm(root,{recursive:true,force:true})}
})
test('never prevents real shell execution and new file creation', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-unit-'))
 try {
  const marker=join(root,'should-not-exist')
  const ctx:ToolContext={sessionId:'never',botId:'test',cwd:root,signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),localExecutionPolicy:'never-allow',allowlist:['*']},requestApproval:async()=>{throw Error('must not ask')}}
  const result=await shellTool.handler({command:'touch '+marker},ctx)
  assert.equal(result.ok,false);await assert.rejects(readFile(marker))
 } finally {await rm(root,{recursive:true,force:true})}
})


test('a live real shell is cancelled when local execution is revoked', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-shell-'))
 try {
  const s={...defaultSettings(),localExecutionPolicy:'always-allow' as const}
  let sawOutput=false
  const ctx:ToolContext={sessionId:'running-shell',botId:'test',messageId:'shell-message',cwd:root,signal:new AbortController().signal,emit(event){if(event.type==='tool-result'&&JSON.stringify(event).includes('SHELL_STARTED'))sawOutput=true},settings:s,requestApproval:async()=>true}
  const running=shellTool.handler({command:'printf SHELL_STARTED; sleep 10'},ctx)
  const end=Date.now()+2000
  while(!sawOutput&&Date.now()<end)await new Promise(r=>setTimeout(r,10))
  assert.equal(sawOutput,true,'The real child must report output before revocation')
  noteLocalPermissionSettings({...s,localExecutionPolicy:'never-allow'})
  const result=await running
  assert.equal(result.ok,false);assert.match(result.output,/SHELL_STARTED/);assert.match(result.output,/permission changed/)
  assert.ok(result.durationMs!<3000)
 }finally{await rm(root,{recursive:true,force:true})}
})


test('every-time denies preview reads before unchanged writes or failing edits can inspect a file', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-preview-'))
 try {
  await writeFile(join(root,'fixture.txt'),'KEEP_PRIVATE_FIXTURE')
  let asks=0
  const ctx:ToolContext={sessionId:'preview',botId:'test',cwd:root,signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),localExecutionPolicy:'ask-every-time',allowlist:['*']},requestApproval:async()=>{asks++;return false}}
  const unchanged=await writeFileTool.handler({path:'fixture.txt',content:'KEEP_PRIVATE_FIXTURE'},ctx)
  const edit=await editFileTool.handler({path:'fixture.txt',old_string:'missing',new_string:'new'},ctx)
  assert.equal(unchanged.ok,false);assert.equal(edit.ok,false);assert.equal(asks,2)
  assert.ok(!unchanged.output.includes('KEEP_PRIVATE_FIXTURE'));assert.ok(!edit.output.includes('KEEP_PRIVATE_FIXTURE'))
  assert.equal(await readFile(join(root,'fixture.txt'),'utf8'),'KEEP_PRIVATE_FIXTURE')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('a delayed dispatcher cannot use a stale permission snapshot after the user changes modes', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-stale-'))
 try {
  await writeFile(join(root,'fixture.txt'),'STALE_PRIVATE_FIXTURE')
  let prompts=0
  const ctx={sessionId:'stale',botId:'test',cwd:root,signal:new AbortController().signal,emit(){},settings:{...defaultSettings(),localExecutionPolicy:'always-allow' as const},getSettings:()=>({...defaultSettings(),localExecutionPolicy:'never-allow' as const}),requestApproval:async()=>{prompts++;return true}}
  const result=await readFileTool.handler({path:'fixture.txt'},ctx)
  assert.equal(result.ok,false);assert.equal(prompts,0);assert.ok(!result.output.includes('STALE_PRIVATE_FIXTURE'))
 }finally{await rm(root,{recursive:true,force:true})}
})
