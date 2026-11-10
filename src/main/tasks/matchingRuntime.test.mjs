import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture, until } from './controlFixture.mjs'

const context = (summary, scope, extra = {}) => ({ summary, categories: ['开发'], scope, boundaries: ['不发布'], ...extra })
const delegate = (f, prompt, ctx, plan = { workspace: 'auto', workspace_reason: 'Independent test scopes run concurrently.' }, previous) => f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, prompt, '相似标题', previous, undefined, undefined, { ...plan, ...(ctx ? { context: ctx } : {}) })
const match = (f, text = '新增需求', extra = {}, sessionId) => f.command({ action: 'match', text, ...extra }, sessionId)
const candidate = (result, id) => result.candidates.find(value => value.id === id)

test('same titles/categories retain distinct goals, environments and file scope; match never starts work', async () => {
  const f = await fixture()
  try {
    const one = await delegate(f, 'test export', context('项目甲测试环境导出CSV', ['project-a/test', 'src/export']))
    const two = await delegate(f, 'prod export', context('项目乙正式环境导出PDF', ['project-b/prod', 'src/pdf']))
    await until(() => f.state.calls.length === 2)
    const result = await match(f, '项目甲导出还要支持时区', { context: context('项目甲测试环境追加时区', ['src/export/timezone.ts']) })
    assert.equal(result.total, 2)
    assert.equal(candidate(result, one.id).context.summary, '项目甲测试环境导出CSV')
    assert.deepEqual(candidate(result, one.id).scopeOverlap, ['src/export/timezone.ts'])
    assert.equal(candidate(result, two.id).context.summary, '项目乙正式环境导出PDF')
    assert.deepEqual(candidate(result, two.id).scopeOverlap, [])
    assert.equal(f.api.listTasks().length, 2)
    assert.equal(f.state.calls.length, 2)
    const page = await match(f, '比较', { limit: 1 }), rest = await match(f, '比较', { before: page.next, limit: 1 })
    assert.notEqual(page.candidates[0].id, rest.candidates[0].id)
    assert.equal(rest.next, undefined)
  } finally { await f.close() }
})

test('description changes persist without execution; active messages and returned continuation retain one execution context', async () => {
  const f = await fixture()
  try {
    const task = await delegate(f, 'export goal', context('导出CSV', ['src/export']))
    await until(() => f.state.calls.length === 1)
    const originalPlan = { ...f.api.getTask(task.id).plan, context: undefined }
    const updated = context('导出CSV并支持时区', ['src/export/timezone.ts'])
    const result = await f.api.manageTaskTool.handler({ action: 'describe', task_id: task.id, context: updated }, {
      sessionId: f.home.id, botId: f.bot.id, signal: new AbortController().signal, requestApproval: async () => { throw new Error('Metadata changes need no recovery approval') },
      host: { manageTask: (...args) => f.api.manageBackgroundTask(...args) }
    })
    assert.equal(result.ok, true, result.output)
    assert.equal(f.state.calls.length, 1)
    assert.equal(f.api.getTask(task.id).status, 'running')
    const saved = JSON.parse(await readFile(join(f.root, 'tasks', task.id + '.json'), 'utf8'))
    assert.equal(saved.plan.context.summary, updated.summary)
    assert.deepEqual({ ...saved.plan, context: undefined }, originalPlan, 'Describing must preserve every scheduling and session decision')
    assert.equal(candidate(await match(f), task.id).actions.supplement, true)
    assert.equal(candidate(await match(f), task.id).executionBusy, true)
    const message = { action: 'message', taskId: task.id, text: '同时支持时区；保留原导出目标', requestId: 'timezone-change' }
    assert.equal((await f.command(message)).receipt.status, 'queued')
    f.state.gates.get(task.sessionId).release()
    await until(() => f.api.getTask(task.id).status === 'completed')
    assert.equal(f.state.calls.length, 2)
    assert.match(f.state.calls[1].text, /同时支持时区/)
    const same = await delegate(f, '再核验时区输出', undefined, {}, task.id)
    await until(() => f.api.getTask(same.id).status === 'completed')
    assert.equal(same.sessionId, task.sessionId)
    assert.deepEqual(same.plan.context, saved.plan.context)
    assert.equal((await match(f)).total, 1, 'superseded attempts do not crowd out unrelated goals')
    const changed = await delegate(f, '新增JSON输出', context('导出CSV和JSON并支持时区', ['src/export']), {}, same.id)
    assert.equal(changed.plan.context.summary, '导出CSV和JSON并支持时区')
    assert.equal(changed.workspace.path, f.api.getTask(task.id).workspace.path)
    assert.equal(f.state.stopped.length, 0)
  } finally { await f.close() }
})

test('split ownership, actual dependencies, overlaps and source ownership remain separate facts', async () => {
  const f = await fixture()
  try {
    const parent = await delegate(f, 'overall', context('总任务：导出与界面', ['src/export', 'src/ui']))
    await until(() => f.state.calls.length === 1)
    const child = await delegate(f, 'export child', context('独立完成导出', ['src/export'], { parent_task_id: parent.id }))
    await until(() => f.state.calls.length === 2)
    assert.deepEqual(child.plan.dependencies, [], 'scope ownership must not block independent parallel work')
    assert.match(f.state.calls.find(value => value.id === child.sessionId).text, /总任务：导出与界面/)
    const dependent = await delegate(f, 'integration after export', context('集成导出结果', ['src/export'], { parent_task_id: parent.id }), { depends_on: [child.id] })
    assert.equal(f.api.getTask(dependent.id).status, 'queued')
    const facts = await match(f, 'src/export新增字段', { context: context('新增导出字段', ['src/export']) })
    assert.deepEqual(candidate(facts, dependent.id).scheduling.waiting, [child.id])
    assert.equal(candidate(facts, child.id).activeConsumerCount, 1)
    assert.equal(candidate(facts, child.id).activeConsumers[0].id, dependent.id)
    assert.ok(candidate(facts, parent.id).relatedTaskIds.includes(child.id))
    assert.equal(candidate(facts, child.id).actions.continue, false)
    const other = f.api.createBot({ name: 'Other', backendId: 'codex', modelId: 'fixture' })
    f.api.saveSession({ ...f.api.getSession(f.home.id), botIds: [f.bot.id, other.id] })
    assert.equal((await f.command({ action: 'match', text: 'read foreign' }, f.home.id, other.id)).total, 0)
    assert.equal((await match(f, 'sibling work', {}, parent.sessionId)).total, 1)
    await assert.rejects(f.command({ action: 'describe', taskId: child.id, context: context('steal scope', []) }, parent.sessionId), /scope/)
    await assert.rejects(f.command({ action: 'describe', taskId: parent.id, context: context('cycle', [], { parent_task_id: child.id }) }), /cycle/)
    await assert.rejects(delegate(f, 'foreign parent', context('bad', [], { parent_task_id: 'missing' })), /belong/)
    const chat = f.api.createSession([f.bot.id]); f.api.saveSession({ ...chat, mode: 'agent', cwd: f.root })
    assert.equal(candidate(await match(f, 'from another chat', {}, chat.id), child.id).sameConversation, false)
    assert.equal(candidate(await match(f, 'from another chat', {}, chat.id), child.id).actions.continue, false)
    f.state.gates.get(child.sessionId).release()
    await until(() => f.api.getTask(dependent.id).status === 'running')
    assert.equal(f.api.getTask(parent.id).status, 'running')
  } finally { await f.close() }
})

test('legacy and private context readback stays usable; describing a stopped task never resumes it', async () => {
  const f = await fixture()
  try {
    const task = await f.start('legacy goal token=not-a-real-secret-value')
    const legacy = candidate(await match(f, 'password=test-secret-value'), task.id)
    assert.equal(legacy.contextSource, 'legacy_excerpt')
    assert.ok(!JSON.stringify(legacy).includes('not-a-real-secret-value'))
    assert.ok(!JSON.stringify(await match(f, 'password=test-secret-value')).includes('test-secret-value'))
    const secret = context('goal authorization: Bearer sensitive-test-string', ['src/a'], { boundaries: ['password=private-test-password'] })
    await f.command({ action: 'describe', taskId: task.id, context: secret })
    const stored = await readFile(join(f.root, 'tasks', task.id + '.json'), 'utf8')
    assert.ok(!stored.includes('sensitive-test-string'))
    assert.ok(!stored.includes('private-test-password'))
    await f.command({ action: 'stop', taskId: task.id })
    f.state.gates.get(task.sessionId).release()
    await until(async () => !candidate(await match(f), task.id).executionBusy)
    await f.command({ action: 'describe', taskId: task.id, context: context('保留已停止工作的简介', ['src/a']) })
    const facts = candidate(await match(f), task.id)
    assert.equal(facts.actions.resumeNeedsUserConfirmation, true)
    assert.equal(facts.actions.continue, false)
    assert.equal(f.api.getTask(task.id).status, 'cancelled')
    await assert.rejects(f.command({ action: 'resume', taskId: task.id, text: 'continue without consent' }), /confirmation/)
    assert.equal(f.api.getTask(task.id).status, 'cancelled')
  } finally { await f.close() }
})


test('new-task receipts expose missing context and the exact correction contract without duplicating execution', async()=>{
  const f=await fixture()
  try {
    const ctx={sessionId:f.home.id,botId:f.bot.id,signal:new AbortController().signal,callId:'new-task',host:{delegateTask:f.api.delegateBackgroundTask,manageTask:f.api.manageBackgroundTask,listBots:async()=>[f.api.getBot(f.bot.id)]},requestApproval:async()=>{throw Error('metadata repair must not invent a new permission gate')}}
    const started=await f.api.delegateTaskTool.handler({prompt:'Synthetic goal',title:'Synthetic task'},ctx)
    assert.equal(started.ok,true);assert.equal(started.detail.contextSaved,false);assert.match(started.output,/context=\{/);assert.match(started.output,/do not create another task/)
    const taskId=started.detail.taskId
    await until(()=>f.state.calls.length===1)
    const failed=await f.api.manageTaskTool.handler({action:'describe',task_id:taskId,text:'Cannot replace the context object'},ctx)
    assert.equal(failed.ok,false);assert.match(failed.output,/context, not text/);assert.match(failed.output,/same task_id/)
    assert.equal(f.api.getTask(taskId).plan.context,undefined)
    const saved=await f.api.manageTaskTool.handler({action:'describe',task_id:taskId,context:context('Synthetic goal',['synthetic/module'])},ctx)
    assert.equal(saved.ok,true);assert.equal(f.api.getTask(taskId).plan.context.summary,'Synthetic goal')
    assert.equal(f.api.listTasks().length,1);assert.equal(f.state.calls.length,1);assert.equal(f.api.getTask(taskId).sessionId,started.detail.sessionId)
  } finally {await f.close()}
})
