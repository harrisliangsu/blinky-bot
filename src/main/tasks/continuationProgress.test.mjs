import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, until } from './controlFixture.mjs'

test('actual continuation admission holds an identical failed plan, allows a new probe/context, and never declares completion',async()=>{
 const f=await fixture()
 try{
  f.state.send=async(id,text)=>{f.state.calls.push({id,text});throw Error('Synthetic repeatable failure; no external action')}
  const first=await f.start('Complete the original local report without publishing')
  await until(()=>f.api.getTask(first.id).status==='failed')
  const second=await f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'Inspect the existing local observation',undefined,first.id)
  await until(()=>f.api.getTask(second.id).status==='failed')
  assert.equal(f.api.getTask(first.id).result,f.api.getTask(second.id).result)
  await assert.rejects(f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'Inspect the existing local observation',undefined,second.id),/same execution plan/)
  assert.equal(f.api.listTasks().length,2)
  const adjusted=await f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'Read a different local source to establish why the check failed',undefined,second.id)
  await until(()=>f.api.getTask(adjusted.id).status==='failed')
  assert.equal(adjusted.sessionId,first.sessionId)
  assert.equal(f.api.listTasks().some(task=>task.review?.outcome==='complete_claimed'),false)
  const source=f.api.getSession(f.home.id)
  f.api.saveSession({...source,messages:[...source.messages,{id:'new-user-fact',role:'user',content:'Here is a new observed detail; continue the same authorized scope.',createdAt:1}]})
  const changed=await f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'Read a different local source to establish why the check failed',undefined,adjusted.id)
  assert.equal(changed.sessionId,first.sessionId)
 }finally{await f.close()}
})

test('blocked question cannot be used to obtain a normal implementation choice or bypass cancellation recovery',async()=>{
 const f=await fixture()
 try{
  const task=await f.start();f.state.gates.get(task.sessionId).release();await until(()=>f.api.getTask(task.id).status==='completed')
  const q={id:'ordinary',header:'格式',kind:'implementation',question:'临时内部报告格式？'}
  await assert.rejects(f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'blocked','普通细节',[],undefined,q),/genuine unresolved/)
  await f.api.cancelBackgroundTask(task.id)
  const cancelled=f.api.cancelAgentTask(task.id)
  await assert.rejects(f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'No fresh user recovery confirmation',undefined,cancelled.id),/confirmation|cancelled/)
  assert.equal(f.api.listTasks().length,1)
 }finally{await f.close()}
})
test('a removed responsible Bot cannot store a completion claim or open another clarification',async()=>{
 const f=await fixture()
 try{
  const task=await f.start();f.state.gates.get(task.sessionId).release();await until(()=>f.api.getTask(task.id).status==='completed')
  const source=f.api.getSession(f.home.id);f.api.saveSession({...source,botIds:[],activeBotId:undefined})
  await assert.rejects(f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'complete_claimed','stale caller',['untrusted claim']),/original task owner/)
  assert.equal(f.api.getTask(task.id).review,undefined)
 }finally{await f.close()}
})
test('an Agent cancellation cannot be silently re-asked by the owning Bot under the result-review interface',async()=>{
 const f=await fixture()
 try{
  const question={id:'scope',header:'范围',kind:'preference',question:'这份报告需要哪种披露范围？'}
  const task=await f.start(),controller=new AbortController()
  const pending=f.api.requestTaskClarification(task.sessionId,f.bot.id,[question],controller.signal)
  let record;await until(async()=>{record=(await f.api.listTaskClarifications(task.id)).find(q=>q.status==='waiting_user');return record})
  await f.api.cancelTaskClarification(record.id);assert.equal(await pending,null)
  f.state.gates.get(task.sessionId).release();await until(()=>f.api.getTask(task.id).status==='completed')
  await assert.rejects(f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'blocked','重提旧问题',[],undefined,question),/already closed/)
  assert.equal((await f.api.listTaskClarifications(task.id)).length,1)
  await assert.rejects(f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'blocked','换问题ID重提',[],undefined,{...question,id:'new-id-only',header:'另一个标题'}),/already closed/)
  const source=f.api.getSession(f.home.id);f.api.saveSession({...source,messages:[...source.messages,{id:'genuine-new-context',role:'user',content:'补充新的报告受众，继续原范围。',createdAt:1}]})
  await f.api.reviewBackgroundTask(f.home.id,f.bot.id,task.id,'blocked','结合新上下文确定范围',[],undefined,question)
  await until(async()=>(await f.api.listTaskClarifications(task.id)).some(q=>q.id!==record.id&&q.status==='waiting_user'))
  // Returned-task decision services are detached; close through the task stop.
  await f.api.cancelBackgroundTask(task.id)
 }finally{await f.close()}
})
