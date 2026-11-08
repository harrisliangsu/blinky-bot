import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, until } from './controlFixture.mjs'
const updates = f => f.api.getSession(f.home.id).messages.filter(m => m.id.startsWith('agent-monitor-') || m.id.startsWith('agent-result-notice-'))
const answer = (text, evidenceIds=[]) => ({text:JSON.stringify({kind:'milestone',text,evidenceIds}),calls:[]})
const silent = {text:'{"kind":"silent"}',calls:[]}
const settled = async (f,t) => until(async()=>{try{const s=JSON.parse(await readFile(join(f.root,'task-progress',t.id+'.json'),'utf8'));return s.assessed&&!s.pending}catch{return false}})

test('only a declared unsupported native model-only profile uses the guarded owning-Bot path',async()=>{
 const f=await fixture()
 try{
  const t=await f.start('native protected judgment'),snapshot=f.api.progressSnapshot(t),signal=new AbortController().signal
  f.state.nativeBackend=true;f.state.pureInterface=true
  f.state.protectedAnswer={state:'ready',text:'{"kind":"silent"}'}
  f.state.sideCallError='network failure'
  assert.equal(await f.api.judgeTaskProgress(snapshot,signal),null)
  assert.equal(f.state.protectedCalls?.length??0,0)
  delete f.state.sideCallError;f.state.sideCallUnavailable=new f.api.ModelOnlyUnavailableError('profile unavailable')
  assert.equal((await f.api.judgeTaskProgress(snapshot,signal))?.kind,'silent')
  assert.equal(f.state.protectedCalls.length,1)
  const prompt=f.state.protectedCalls[0].prompt
  assert.match(prompt,/Private internal decisions/);assert.match(prompt,/existing task channel/)
 }finally{await f.close()}
})

test('outgoing transport states and correlated replies remain separate evidence, scoped to the actual task',async()=>{
 const f=await fixture()
 try{
  const started=await f.start('communication evidence'),t=f.api.getTask(started.id),now=Date.now();assert.equal(t.status,'running')
  const s=f.api.progressSnapshot(t,[{taskId:t.id,requestId:'advice',direction:'to_executor',text:'Use compact prose',status:'delivering',createdAt:now,updatedAt:now},{taskId:t.id,requestId:'reply:advice',direction:'to_lead',text:'Received and applied compact prose',status:'delivered',createdAt:now,updatedAt:now}])
  const receipt=JSON.parse(s.evidence.find(e=>e.id==='delivery:advice').text)
  assert.equal(receipt.status,'delivering');assert.equal(receipt.responseMessageIds,undefined)
  assert.equal(s.evidence.find(e=>e.id==='report:reply:advice').text,'Received and applied compact prose')
  const transportOnly=f.api.progressSnapshot(t,[{taskId:t.id,requestId:'advice',direction:'to_executor',text:'Use compact prose',status:'delivered',createdAt:now,updatedAt:now}])
  assert.equal(transportOnly.progress,f.api.progressSnapshot(t).progress)
  assert.notEqual(s.progress,transportOnly.progress)
 }finally{await f.close()}
})

test('publication and coordination share one owning-Bot judgment for the same observation',async()=>{
 const f=await fixture()
 try{
  const t=await f.start('quiet internal preparation');f.api.installTaskProgressMonitor();await settled(f,t)
  let release;const gate=new Promise(r=>release=r)
  f.state.progressAnswer=async()=>{await gate;return silent}
  await f.command({action:'report',taskId:t.id,requestId:'detail',text:'Ordinary internal preparation only'},t.sessionId)
  await until(()=>f.state.sideCalls.length===1);await new Promise(r=>setTimeout(r,80));assert.equal(f.state.sideCalls.length,1)
  const input=JSON.parse(f.state.sideCalls[0][1].messages[1].content)
  assert.equal(input.coordination.newReport,'detail');assert.equal(input.coordination.due,false)
  release();await settled(f,t);await new Promise(r=>setTimeout(r,650));assert.equal(f.state.sideCalls.length,1);assert.equal(updates(f).length,0)
 }finally{await f.close()}
})

test('automatic judgment receives same-executor independent tool metadata without native file bodies or sibling receipts',async()=>{
 const f=await fixture()
 try{
  const a=await f.start('current read'),b=await f.start('sibling read')
  const receipt=path=>[{id:'read-1',kind:'read',phase:'completed',detail:JSON.stringify({status:'completed',rawInput:{path},content:[{content:{text:'PRIVATE_NATIVE_FILE_BODY'}}]})}]
  f.reply(a.sessionId,'Read stage returned',{agentTrace:receipt('/synthetic/current.txt')})
  f.reply(b.sessionId,'Sibling returned',{agentTrace:receipt('/synthetic/sibling.txt')})
  const s=f.api.progressSnapshot(f.api.getTask(a.id)),tool=s.evidence.find(e=>e.id.startsWith('execution:'))
  assert.equal(JSON.parse(tool.text).state,'completed');assert.equal(JSON.parse(tool.text).target,'/synthetic/current.txt')
  assert.equal(JSON.stringify(s).includes('PRIVATE_NATIVE_FILE_BODY'),false);assert.equal(JSON.stringify(s).includes('sibling.txt'),false)
 }finally{await f.close()}
})

test('broken coordination state blocks communication without silencing a separately observed failure',async()=>{
 const f=await fixture()
 try{
  const t=await f.start('synthetic failure')
  await f.api.writeJsonNow(join(f.root,'task-coordination',t.id+'.json'),{version:999})
  f.state.answer=answer('任务暂时无法继续，已有结果已保留。')
  f.api.completeAgentTask(t.id,'synthetic failure',true);f.api.installTaskProgressMonitor()
  await until(()=>updates(f).length===1);assert.equal(f.state.steering.length,0)
 }finally{await f.close()}
})

test('Agent reports and host observations both go through owning Bot judgment; no idle/detail reports, plain milestones, dedupe and restart', async()=>{
 const f=await fixture()
 try{
  f.state.answer=silent; f.api.installTaskProgressMonitor()
  const a=await f.start('make the phone chat usable'), b=await f.start('unrelated sibling')
  await settled(f,a); assert.equal(updates(f).length,0)
  await f.command({action:'report',taskId:a.id,requestId:'detail',text:'Internal step: edited a file; one unit test passed.'},a.sessionId)
  await until(()=>f.state.sideCalls.length>=1); await settled(f,a); assert.equal(updates(f).length,0)
  assert.equal((await f.command({action:'report',taskId:a.id,requestId:'detail-copy',text:'Internal step: edited a file; one unit test passed.'},a.sessionId)).duplicate,true)
  f.state.progressAnswer=(_backend,req)=>{
    const input=JSON.parse(req.messages[1].content)
    if(input.observations.some(e=>e.id==='report:usable'))return answer('手机现在能发送图片，重新打开页面也不会丢草稿。',['report:usable'])
    return silent
  }
  await f.command({action:'report',taskId:a.id,requestId:'usable',text:'Synthetic outcome: photo upload/send and refresh draft retention verified with owned fixtures.'},a.sessionId)
  await until(()=>updates(f).length===1); await settled(f,a)
  assert.match(updates(f)[0].content,/手机现在能发送图片/);assert.equal(updates(f)[0].content.includes('fixtures'),false)
  const request=JSON.parse(f.state.sideCalls.at(-1)[1].messages[1].content)
  assert.equal(request.goal,'make the phone chat usable'); assert.equal(JSON.stringify(request).includes('unrelated sibling'),false)
  assert.equal(f.state.sideCalls.at(-1)[1].disableNativeTools,true)
  const calls=f.state.sideCalls.length;f.api.stopTaskProgressMonitor();f.api.installTaskProgressMonitor();await new Promise(r=>setTimeout(r,750))
  assert.equal(updates(f).length,1);assert.equal(f.state.sideCalls.length,calls)
  // Host-observed final messages are also judged, never copied verbatim.
  f.state.progressAnswer=(_backend,req)=>{
    const input=JSON.parse(req.messages[1].content);const proof=input.observations.find(e=>e.text==='Host-observed evidence: synthetic recovery verified')
    return proof ? answer('更新后会自动恢复连接，未发送的内容仍会保留。',[proof.id]) : silent
  }
  f.reply(b.sessionId,'Host-observed evidence: synthetic recovery verified');f.api.event({type:'message-end',sessionId:b.sessionId,messageId:'ignored',content:'not the source'})
  await until(()=>updates(f).length===2);assert.ok(updates(f).at(-1).id.startsWith(`agent-monitor-${b.id}-`))
  assert.equal(updates(f).some(m=>m.content.includes('Host-observed')),false)
  assert.equal(f.api.taskProgressContext(a.sessionId,f.bot.id),undefined)
  assert.ok(f.api.taskProgressContext(f.home.id,f.bot.id).includes(a.id))
 }finally{await f.close()}
})

test('failure and required action are summarized by Bot; unavailable inference keeps the event retryable without host prose',async()=>{
 const f=await fixture()
 try{
  f.state.answer=null;const a=await f.start('synthetic action');f.api.installTaskProgressMonitor()
  f.api.event({type:'approval-request',request:{id:'ap',sessionId:a.sessionId,summary:'private argument must not be copied'}})
  await until(()=>f.state.sideCalls.length>0);assert.equal(updates(f).length,0)
  f.state.answer=answer('继续前需要你确认，请打开任务查看。')
  f.api.event({type:'todos',sessionId:a.sessionId,todos:[]})
  await until(()=>updates(f).length===1);assert.equal(updates(f)[0].content.includes('private argument'),false)
  f.api.event({type:'approval-resolved',sessionId:a.sessionId,requestId:'ap'})
  f.state.answer=answer('连接验证失败，任务暂时无法继续；已有内容已保留。')
  f.api.completeAgentTask(a.id,'synthetic failure',true);f.api.event({type:'task-updated',task:f.api.getTask(a.id)})
  await until(()=>updates(f).length===2);assert.match(updates(f).at(-1).content,/连接验证失败/)
  await settled(f,a);f.api.stopTaskProgressMonitor();f.api.installTaskProgressMonitor();await new Promise(r=>setTimeout(r,750));assert.equal(updates(f).length,2)
  assert.equal(f.state.calls.length,1)
 }finally{await f.close()}
})

test('membership removal and changed source context prevent stale inference delivery; same names do not change ownership',async()=>{
 const f=await fixture()
 try{
  const a=await f.start('same name'),b=await f.start('same name');let release
  const gate=new Promise(r=>release=r);f.state.progressAnswer=async()=>{await gate;return answer('已能使用。',['report:proof'])}
  await f.command({action:'report',taskId:a.id,requestId:'proof',text:'synthetic outcome'},a.sessionId);f.api.installTaskProgressMonitor()
  await until(()=>f.state.sideCalls.length>0)
  f.api.saveSession({...f.api.getSession(f.home.id),botIds:[]});release();await new Promise(r=>setTimeout(r,750));assert.equal(updates(f).length,0)
  assert.equal((await f.command({action:'list'},a.sessionId)).total,1)
  await assert.rejects(f.command({action:'inspect',taskId:b.id},a.sessionId),/scope/)
 }finally{await f.close()}
})

test('legacy quiet outboxes never replay; observation faults do not publish a template or restart work',async()=>{
 const f=await fixture()
 try{
  const a=await f.start('legacy'), snapshot=f.api.progressSnapshot(a)
  await f.api.writeJsonNow(join(f.root,'task-progress',a.id+'.json'),{version:1,owner:snapshot.owner,phase:'running',progress:'old',sequence:1,lastProgressAt:0,lastNoticeAt:0,quietReported:true,pending:{id:'old-quiet',snapshot:'old',kind:'quiet',text:'still running'}})
  f.state.answer=silent;f.api.installTaskProgressMonitor();await settled(f,a)
  assert.equal(updates(f).length,0);assert.equal(f.state.calls.length,1)
  const state=JSON.parse(await readFile(join(f.root,'task-progress',a.id+'.json'),'utf8'));assert.equal(state.version,2);assert.equal(state.pending,undefined)
 }finally{await f.close()}
})
