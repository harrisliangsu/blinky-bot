import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, until } from './controlFixture.mjs'
const question = (id) => ({id,header:'',kind:'preference',question:'具体问题 '+id,options:[{label:'选择一',description:'按此处理'},{label:'选择二',description:'另一方式'}]})
const waiting = async f => {let request;await until(async()=>{request=(await f.api.listTaskClarifications()).find(q=>q.status==='waiting_user');return request});return request}
const plain = value => JSON.parse(JSON.stringify(value))
test('multi-blocker request asks one question at a time, persists exact partial answers and continues only after all replies',async()=>{
 const f=await fixture()
 try {
  const t=await f.start(),c=new AbortController();let finished=false
  const result=f.api.requestTaskClarification(t.sessionId,f.bot.id,[question('first'),question('second')],c.signal).then(r=>{finished=true;return r})
  const r=await waiting(f),placement={anchorMessageId:r.anchorMessageId,afterMessageId:r.afterMessageId,askedAt:r.askedAt}
  await assert.rejects(f.api.answerTaskClarification(r.id,{second:['选择二']}),/current question/)
  let receipt=await f.api.answerTaskClarification(r.id,{first:['选择一']})
  assert.equal(receipt.status,'waiting_user');assert.equal(finished,false);assert.deepEqual(plain(receipt.userAnswers),{first:['选择一']})
  const disk=JSON.parse(await readFile(join(f.root,'task-clarifications',r.id+'.json'),'utf8')).request
  assert.deepEqual(disk.userAnswers,{first:['选择一']});assert.equal(disk.answeredBy,undefined)
  receipt=await f.api.answerTaskClarification(r.id,{second:['我的实际回答']})
  assert.equal(receipt.status,'answered');assert.deepEqual(plain(await result),{first:['选择一'],second:['我的实际回答']})
  assert.deepEqual({anchorMessageId:receipt.anchorMessageId,afterMessageId:receipt.afterMessageId,askedAt:receipt.askedAt},placement)
 }finally{await f.close()}
})
test('two Agents queue user questions one at a time while independent execution remains available',async()=>{
 const f=await fixture()
 try{
  const iso={workspace:'isolated',workspace_reason:'Independent scopes must run concurrently for this test.'}
  const a=await f.start('需要用户选择的范围',iso),b=await f.start('另一个独立范围',iso),ca=new AbortController(),cb=new AbortController()
  const pa=f.api.requestTaskClarification(a.sessionId,f.bot.id,[question('a')],ca.signal)
  const ra=await waiting(f)
  const pb=f.api.requestTaskClarification(b.sessionId,f.bot.id,[question('b')],cb.signal)
  await until(async()=>(await f.api.listTaskClarifications()).length===2)
  assert.equal((await f.api.listTaskClarifications()).filter(r=>r.status==='waiting_user').length,1)
  assert.equal(f.api.getTask(a.id).status,'running');assert.equal(f.api.getTask(b.id).status,'running')
  assert.equal(f.state.calls.length,2,'independent executor was started despite the pending question')
  await f.api.cancelTaskClarification(ra.id);assert.equal(await pa,null)
  const rb=await waiting(f);assert.notEqual(rb.id,ra.id)
  await f.api.answerTaskClarification(rb.id,{b:['选择二']});assert.deepEqual(plain(await pb),{b:['选择二']})
 }finally{await f.close()}
})
test('returned-result clarification is owned by original Bot/task and a blocked review stays in context until continued',async()=>{
 const f=await fixture()
 try{
  const t=await f.start('完成原始用户目标');f.state.gates.get(t.sessionId).release()
  await until(()=>f.api.getTask(t.id).status==='completed')
  const p=f.api.withClarificationReview(f.home.id,t.id,f.bot.id,()=>f.api.requestTaskClarification(f.home.id,f.bot.id,[question('choice')],new AbortController().signal))
  const r=await waiting(f);assert.equal(r.reviewTaskId,t.id);assert.equal(r.taskId,t.id)
  await f.api.answerTaskClarification(r.id,{choice:['选择一']});assert.deepEqual(plain(await p),{choice:['选择一']})
  await f.api.reviewBackgroundTask(f.home.id,f.bot.id,t.id,'blocked','真实环境尚不可用，保留工作',[])
  assert.match(f.api.taskProgressContext(f.home.id,f.bot.id),/真实环境尚不可用/)
  const continued=await f.api.delegateBackgroundTask(f.home.id,f.bot.id,f.bot.id,'用户选择一后继续核验；先检查已有结果',undefined,t.id)
  assert.equal(continued.sessionId,t.sessionId);assert.equal(continued.continuedFromTaskId,t.id)
  assert.equal(f.api.taskProgressContext(f.home.id,f.bot.id).includes('真实环境尚不可用'),false)
 }finally{await f.close()}
})
test('fresh turn signals and request IDs cannot repeat a cancelled question without new user context',async()=>{
 const f=await fixture()
 try{
  const t=await f.start(),first=f.api.requestTaskClarification(t.sessionId,f.bot.id,[question('same')],new AbortController().signal,'first')
  const r=await waiting(f);await f.api.cancelTaskClarification(r.id);assert.equal(await first,null)
  assert.equal(await f.api.requestTaskClarification(t.sessionId,f.bot.id,[question('same')],new AbortController().signal,'new-transport-id'),null)
  assert.equal((await f.api.listTaskClarifications(t.id)).length,1)
 }finally{await f.close()}
})
test('same question from concurrent native signals shares one card and original answer',async()=>{
 const f=await fixture()
 try{
  const t=await f.start()
  const a=f.api.requestTaskClarification(t.sessionId,f.bot.id,[question('same')],new AbortController().signal,'a')
  const b=f.api.requestTaskClarification(t.sessionId,f.bot.id,[question('same')],new AbortController().signal,'b')
  const r=await waiting(f);assert.equal((await f.api.listTaskClarifications(t.id)).length,1)
  await f.api.answerTaskClarification(r.id,{same:['实际回答']});assert.deepEqual(plain(await a),plain(await b))
 }finally{await f.close()}
})
test('a pending user decision does not delay another Agent ordinary reversible Bot decision',async()=>{
 const f=await fixture()
 try{
  const s=f.api.getSession(f.home.id);f.api.saveSession({...s,messages:[...s.messages,{id:'goal',role:'user',content:'完成报告，普通可逆细节自行决定。',createdAt:1}]})
  const iso={workspace:'isolated',workspace_reason:'Independent scopes must run concurrently for this test.'}
  const a=await f.start('需要用户偏好',iso),b=await f.start('独立的报告格式',iso)
  const first=f.api.requestTaskClarification(a.sessionId,f.bot.id,[question('preference')],new AbortController().signal)
  const r=await waiting(f)
  f.state.answer={text:JSON.stringify({answers:{format:{kind:'decision',answer:'Markdown',reason:'本地可逆格式',routineReversible:true,requiresUserAuthorization:false}}}),calls:[]}
  const answer=await f.api.requestTaskClarification(b.sessionId,f.bot.id,[{id:'format',header:'',question:'内部临时报告格式？',kind:'implementation'}],new AbortController().signal)
  assert.deepEqual(plain(answer),{format:['Markdown']})
  assert.equal((await f.api.listTaskClarifications()).filter(r=>r.status==='waiting_user').length,1)
  await f.api.cancelTaskClarification(r.id);assert.equal(await first,null)
 }finally{await f.close()}
})
