import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, until } from './controlFixture.mjs'

test('host automatically reports independent tasks while the lead is busy; contexts and notifications remain source scoped', async () => {
 const f=await fixture()
 try {
  f.api.installTaskProgressMonitor()
  const a=await f.start('synthetic one'), b=await f.start('synthetic two')
  await until(()=>f.api.getSession(f.home.id).messages.filter(m=>m.id.startsWith('agent-monitor-')).length===2)
  assert.equal((await f.command({action:'list'},a.sessionId)).total,1)
  await assert.rejects(f.command({action:'inspect',taskId:b.id},a.sessionId),/scope/)
  assert.equal(f.api.taskProgressContext(a.sessionId,f.bot.id),undefined)
  assert.match(f.api.taskProgressContext(f.home.id,f.bot.id),new RegExp(a.id))
  const other=f.api.createBot({name:'Foreign',backendId:'codex',modelId:'fixture'})
  assert.equal(f.api.taskProgressContext(f.home.id,other.id),undefined)
  f.api.event({type:'task-clarification-updated',request:{id:'q',executionSessionId:a.sessionId,sourceSessionId:f.home.id,botId:f.bot.id,taskId:a.id,questions:[],status:'waiting_user'}})
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.content.includes('synthetic one')&&m.content.includes('等你补充信息')))
  assert.match(f.api.taskProgressContext(f.home.id,f.bot.id),/waiting_user/)
  f.api.event({type:'task-clarification-updated',request:{id:'q',executionSessionId:a.sessionId,status:'answered'}})
  f.api.event({type:'backend-notice',sessionId:b.sessionId,category:'reconnect',message:'do not copy this transport body'})
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.content.includes('synthetic two')&&m.content.includes('正在恢复连接')))
  assert.equal(f.api.getSession(f.home.id).messages.some(m=>m.content.includes('do not copy')),false)
  f.api.event({type:'text-delta',sessionId:b.sessionId,messageId:'x',delta:'private transcript'})
  assert.match(f.api.taskProgressContext(f.home.id,f.bot.id),/running/)
  await f.command({action:'stop',taskId:a.id});await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.content.includes('synthetic one')&&m.content.includes('已停止')))
  await until(async()=>!JSON.parse(await readFile(join(f.root,'task-progress',a.id+'.json'),'utf8')).pending);const saved=JSON.parse(await readFile(join(f.root,'task-progress',a.id+'.json'),'utf8'));assert.equal(saved.phase,'cancelled');assert.equal(saved.pending,undefined)
  const count=f.api.getSession(f.home.id).messages.length
  f.api.stopTaskProgressMonitor();f.api.installTaskProgressMonitor();await new Promise(r=>setTimeout(r,750))
  assert.equal(f.api.getSession(f.home.id).messages.filter(m=>m.content.includes('synthetic one')&&m.content.includes('已停止')).length,1)
  assert.equal(f.state.calls.length,2);assert.ok(f.api.getSession(f.home.id).messages.length>=count)
 } finally {await f.close()}
})

test('source membership removal prevents delivery; approval body never enters lead context',async()=>{
 const f=await fixture()
 try {
  const t=await f.start('scope guard');f.api.installTaskProgressMonitor()
  f.api.event({type:'approval-request',request:{id:'approve',sessionId:t.sessionId,summary:'synthetic secret argument must not leave executor'}})
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.content.includes('等你确认操作')))
  assert.equal(f.api.getSession(f.home.id).messages.some(m=>m.content.includes('synthetic secret')),false)
  const before=f.api.getSession(f.home.id).messages.length
  f.api.saveSession({...f.api.getSession(f.home.id),botIds:[]})
  f.api.event({type:'approval-resolved',sessionId:t.sessionId,requestId:'approve'})
  await new Promise(r=>setTimeout(r,700));assert.equal(f.api.getSession(f.home.id).messages.length,before)
 }finally{await f.close()}
})

test('an unreadable monitoring outbox is visible, deduplicated and retried without restarting or overwriting it',async()=>{
 const f=await fixture()
 const {mkdir,rmdir}=await import('node:fs/promises')
 try{
  const t=await f.start('outbox failure'),file=join(f.root,'task-progress',t.id+'.json');await mkdir(file,{recursive:true})
  f.api.installTaskProgressMonitor()
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.id===`agent-monitor-unavailable-${t.id}`))
  f.api.event({type:'todos',sessionId:t.sessionId,todos:[]});await new Promise(r=>setTimeout(r,700))
  assert.equal(f.api.getSession(f.home.id).messages.filter(m=>m.id===`agent-monitor-unavailable-${t.id}`).length,1)
  assert.equal(f.api.getTask(t.id).status,'running');assert.equal(f.state.calls.length,1)
  await rmdir(file);f.api.event({type:'todos',sessionId:t.sessionId,todos:[]})
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.id.startsWith(`agent-monitor-${t.id}-`)))
  assert.equal(f.api.getTask(t.id).status,'running');assert.equal(f.state.calls.length,1)
 }finally{await f.close()}
})

test('multiple Agents and identical display names retain task/session ownership and short progress text',async()=>{
 const f=await fixture()
 try{
  const a=await f.start('同名检查'),b=await f.start('同名检查'),c=await f.start('另一检查')
  const fallback=f.api.getTask(c.id);f.api.setTaskStatus(c.id,'running')
  f.api.saveSession({...f.api.getSession(c.sessionId),title:'实际执行会话名'})
  assert.equal(f.api.progressSnapshot({...fallback,title:''}).title,'实际执行会话名')
  f.api.installTaskProgressMonitor()
  await until(()=>f.api.getSession(f.home.id).messages.filter(m=>m.id.startsWith('agent-monitor-')).length===3)
  const qa={type:'task-clarification-updated',request:{id:'same-name-question',executionSessionId:a.sessionId,taskId:a.id,status:'waiting_user'}}
  f.api.event(qa)
  await until(()=>f.api.getSession(f.home.id).messages.some(m=>m.id.startsWith(`agent-monitor-${a.id}-`)&&m.content==='同名检查：等你补充信息。'))
  const home=f.api.getSession(f.home.id)
  assert.equal(home.messages.some(m=>m.id.startsWith(`agent-monitor-${b.id}-`)&&m.content.includes('等你补充信息')),false)
  assert.equal(home.messages.some(m=>m.id.startsWith(`agent-monitor-${c.id}-`)&&m.content.startsWith('另一检查：')),true)
  for(const m of home.messages.filter(m=>m.id.startsWith('agent-monitor-'))){assert.ok([...m.content].length<=120);assert.equal(/里程碑|分钟|SHA-?256|fixture|worker/.test(m.content),false)}
  const context=f.api.taskProgressContext(f.home.id,f.bot.id)
  assert.ok(context.includes(a.sessionId));assert.ok(context.includes(b.sessionId));assert.match(context,/"name":"同名检查"/)
 }finally{await f.close()}
})
