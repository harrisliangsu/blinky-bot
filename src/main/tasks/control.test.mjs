import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture, until } from './controlFixture.mjs'

test('Bot lists its tasks across chats; foreign Bot and sibling executors cannot manage them', async () => {
  const f = await fixture()
  try {
    const first = await f.start(), second = await f.start('second work')
    assert.equal((await f.command({ action: 'list' })).total, 2)
    const chat = f.api.createSession([f.bot.id]); f.api.saveSession({ ...chat, mode: 'agent', cwd: f.root })
    assert.equal((await f.command({ action: 'list' }, chat.id)).total, 2)
    const legacy = await f.api.createTaskRecordDurable(f.bot.id, chat.id, 'legacy objective', 'legacy task')
    assert.equal((await f.command({ action: 'list' }, chat.id)).total, 3)
    assert.equal((await f.command({ action: 'inspect', taskId: legacy.id }, chat.id)).task.id, legacy.id)
    await assert.rejects(f.command({ action: 'resume', taskId: legacy.id, text: 'continue' }, chat.id), /legacy task has no independent/)
    const other = f.api.createBot({ name: 'Other', backendId: 'codex', modelId: 'fixture' })
    f.api.saveSession({ ...f.api.getSession(chat.id), botIds: [f.bot.id, other.id] })
    await assert.rejects(f.command({ action: 'inspect', taskId: first.id }, chat.id, other.id), /does not belong/)
    await assert.rejects(f.command({ action: 'stop', taskId: second.id }, first.sessionId), /scope/)
    assert.equal((await f.command({ action: 'inspect', taskId: first.id })).task.review, undefined)
  } finally { await f.close() }
})

test('supplemental instruction uses the same session safe boundary and a durable exactly-once receipt', async () => {
  const f = await fixture()
  try {
    const task = await f.start()
    const message = { action: 'message', taskId: task.id, text: 'also verify actual output', requestId: 'supplement-1' }
    const accepted = await f.command(message)
    assert.equal(accepted.receipt.status, 'queued')
    assert.equal(f.state.calls.length, 1)
    assert.equal((await f.command(message)).duplicate, true)
    await assert.rejects(f.command({ ...message, text: 'different' }), /different message/)
    f.state.gates.get(task.sessionId).release()
    await until(() => f.api.getTask(task.id).status === 'completed')
    assert.equal(f.state.calls.length, 2)
    assert.equal(f.state.calls[1].id, task.sessionId)
    assert.match(f.state.calls[1].text, /also verify actual output/)
    const inspection = await f.command({ action: 'inspect', taskId: task.id })
    assert.equal(inspection.messages[0].status, 'delivered')
    assert.equal(inspection.messages[0].delivery, 'turn_boundary')
    assert.equal(inspection.task.review, undefined)
    assert.equal((await f.command(message)).duplicate, true)
    assert.equal(f.state.calls.length, 2)
    const saved = JSON.parse(await readFile(join(f.root, 'task-messages', `${task.id}.json`), 'utf8'))
    assert.equal(saved.messages[0].status, 'delivered')
  } finally { await f.close() }
})

test('live acknowledgement is distinct from executor completion; uncertain RPC never retries', async () => {
  const f = await fixture()
  try {
    const task = await f.start()
    let delivered = 0
    f.state.steer = async (_id, _text, record) => { delivered++; await record(); return true }
    const receipt = await f.command({ action: 'message', taskId: task.id, text: 'new constraint', requestId: 'live-1' })
    assert.equal(receipt.receipt.status, 'delivered'); assert.equal(receipt.receipt.delivery, 'live')
    assert.equal(f.api.getTask(task.id).status, 'running'); assert.equal(f.api.getTask(task.id).review, undefined)
    f.state.steer = async () => { delivered++; throw new Error('timeout after potential delivery') }
    const command = { action: 'message', taskId: task.id, text: 'do not repeat side effects', requestId: 'timeout-1' }
    assert.equal((await f.command(command)).receipt.status, 'uncertain')
    assert.equal((await f.command(command)).duplicate, true)
    assert.equal(delivered, 2)
    f.state.gates.get(task.sessionId).release(); await until(() => f.api.getTask(task.id).status === 'completed')
    assert.equal(f.state.calls.length, 1)
  } finally { await f.close() }
})

test('an acknowledged live instruction gets a response only after its exact App turn completes',async()=>{
 const f=await fixture()
 try{
  const task=await f.start(),id='live-executor-message'
  f.state.replyExtras={[task.sessionId]:{id}}
  f.api.event({type:'message-start',sessionId:task.sessionId,message:{id,role:'assistant',content:'',streaming:true,createdAt:Date.now()}})
  f.state.steer=async(_id,_text,record)=>{await record();return true}
  const receipt=(await f.command({action:'message',taskId:task.id,text:'use the existing safe direction',requestId:'live-response'})).receipt
  assert.equal(receipt.responseTargetMessageId,id);assert.equal(receipt.responseMessageIds,undefined)
  await f.api.recordTaskTurnResponses(task.id,['different-turn'])
  assert.equal((await f.api.taskMessages(task.id))[0].responseMessageIds,undefined)
  f.state.gates.get(task.sessionId).release();await until(()=>f.api.getTask(task.id).status==='completed')
  assert.deepEqual((await f.api.taskMessages(task.id))[0].responseMessageIds,[id])
  assert.equal(f.api.getTask(task.id).review,undefined)
  f.api.event({type:'done',sessionId:task.sessionId})
 }finally{await f.close()}
})

test('Agent reports are durably delivered to Bot observations, never directly to the user', async () => {
  const f = await fixture()
  try {
    const task = await f.start()
    const command = { action: 'report', taskId: task.id, text: '已完成源码核对，正在验证。', requestId: 'milestone-1' }
    const first = await f.command(command, task.sessionId)
    assert.equal(first.receipt.status, 'delivered')
    assert.equal(f.api.getSession(f.home.id).messages.some(value => value.content.includes(command.text)), false)
    assert.equal(f.state.events.some(value => value.type === 'message-end' && value.sessionId === f.home.id && value.content.includes(command.text)), false)
    assert.equal((await f.command({ ...command, requestId: 'milestone-2' }, task.sessionId)).duplicate, true)
    assert.equal((await f.command({ ...command, text: 'another update', requestId: 'milestone-3' }, task.sessionId)).receipt.status, 'delivered')
  } finally { await f.close() }
})

test('explicit resume preserves session and cancelled attempt; Bot removal fences admission', async () => {
  const f = await fixture()
  try {
    const task = await f.start()
    await f.command({ action: 'stop', taskId: task.id })
    f.state.gates.get(task.sessionId).release()
    await new Promise(resolve => setTimeout(resolve, 20))
    const resumed = await f.command({ action: 'resume', taskId: task.id, text: 'Resume only after inspecting prior actual side effects.' }, undefined, undefined, async () => true)
    assert.equal(resumed.sameSession, true); assert.equal(f.api.getTask(task.id).status, 'cancelled')
    await assert.rejects(f.command({ action: 'resume', taskId: task.id, text: 'repeat' }), /already has a continuation/)
    const release = await f.api.prepareBotTaskRemoval(f.bot.id)
    await assert.rejects(f.api.startBackgroundTask(f.bot.id, 'must not start'), /being removed/)
    assert.equal(f.api.listTasks().filter(value => ['running', 'queued'].includes(value.status)).length, 0)
    release()
    assert.equal((await f.api.startBackgroundTask(f.bot.id, 'allowed after unsuccessful removal')).botId, f.bot.id)
  } finally { await f.close() }
})

for (const outcome of ['cancelled', 'failed']) test(`partial commentary before a ${outcome} executor outcome cannot become completion`, async () => {
  const f = await fixture()
  try {
    f.state.send = async id => {
      f.reply(id, 'I have started inspecting the requested change.', { segments: [{ id: 'progress', phase: 'commentary', text: 'I have started inspecting the requested change.' }] })
      f.api.event({ type: 'done', sessionId: id, outcome })
    }
    const task = await f.api.startBackgroundTask(f.bot.id, 'Complete the whole requested change.', 'shutdown outcome')
    await until(() => ['completed', 'failed', 'cancelled'].includes(f.api.getTask(task.id).status))
    const current = f.api.getTask(task.id)
    assert.equal(current.status, outcome)
    assert.equal(current.review, undefined)
    if (outcome === 'cancelled') assert.equal(current.deliveryStatus, 'uncertain')
    await f.api.flushAll()
    assert.equal(JSON.parse(await readFile(join(f.root, 'tasks', `${task.id}.json`), 'utf8')).status, outcome)
  } finally { await f.close() }
})

test('automatic inquiry stays at a safe boundary while concrete advice uses existing acknowledged live steering',async()=>{
 const f=await fixture()
 try{
  const task=await f.start();let steers=0
  f.state.steer=async(_id,_text,ack)=>{steers++;await ack();return true}
  const inquiry=await f.api.manageBackgroundTask(f.home.id,f.bot.id,{action:'message',taskId:task.id,requestId:'bot-inquiry',text:'Please report observed progress at a safe boundary; this is not new consent.'},new AbortController().signal,undefined,'turn_boundary')
  assert.equal(inquiry.receipt.status,'queued');assert.equal(steers,0)
  const advice=await f.command({action:'message',taskId:task.id,requestId:'bot-advice',text:'Review the isolated failing input first. Existing user permissions still apply.'})
  assert.equal(advice.receipt.status,'delivered');assert.equal(advice.receipt.delivery,'live');assert.equal(steers,1)
  assert.equal((await f.command({action:'message',taskId:task.id,requestId:'bot-advice',text:'Review the isolated failing input first. Existing user permissions still apply.'})).duplicate,true);assert.equal(steers,1)
  assert.equal(f.api.getSession(task.sessionId).messages.filter(m=>m.id.includes('bot-advice')).length,1)
 }finally{await f.close()}
})

test('inspect exposes same-executor native receipts without sibling data or file/code payloads',async()=>{
 const f=await fixture()
 try{
  const a=await f.start('own execution'),b=await f.start('sibling execution')
  for(const [task,path] of [[a,'/tmp/own-a'],[b,'/tmp/sibling-b']]){
   const session=f.api.getSession(task.sessionId)
   f.api.saveSession({...session,messages:[...session.messages,{id:'evidence-'+task.id,role:'assistant',content:'',createdAt:1,agentTrace:[{id:'read',kind:'read',phase:'started',detail:JSON.stringify({rawInput:{path}})},{id:'read',kind:'kimi_tool',phase:'completed',detail:JSON.stringify({status:'completed',content:[{content:{text:'PRIVATE_CODE_BODY'}}]})}]}]})
  }
  const result=await f.command({action:'inspect',taskId:a.id})
  assert.equal(result.executionEvidence[0].state,'completed');assert.equal(result.executionEvidence[0].target,'/tmp/own-a')
  assert.equal(JSON.stringify(result).includes('/tmp/sibling-b'),false);assert.equal(JSON.stringify(result).includes('PRIVATE_CODE_BODY'),false)
  await assert.rejects(f.command({action:'inspect',taskId:b.id},a.sessionId),/scope/)
 }finally{await f.close()}
})
