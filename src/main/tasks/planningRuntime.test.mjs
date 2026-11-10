import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, until } from './controlFixture.mjs'

test('new work gets separate sessions/directories; same-task continuation reuses context and retained workspace', async () => {
  const f = await fixture()
  try {
    const isolated = { workspace: 'isolated', workspace_reason: 'Two writers must not share the source directory in this test.' }
    const begin = async (text, title, plan) => { const task = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, text, title, undefined, undefined, undefined, plan); await until(() => f.state.calls.some(value => value.id === task.sessionId)); return task }
    const one = await begin('first independent task', undefined, isolated), two = await begin('unrelated parallel task', undefined, isolated)
    const first = f.api.getTask(one.id), second = f.api.getTask(two.id)
    assert.notEqual(first.sessionId, second.sessionId); assert.notEqual(first.workspace.path, second.workspace.path)
    assert.equal(first.sessionChoice.mode, 'new'); assert.equal(second.sessionChoice.mode, 'new')
    assert.equal(f.api.getSession(first.sessionId).cwd, first.workspace.path)
    assert.equal(f.api.getSession(f.home.id).cwd, f.root)
    await assert.rejects(f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'competing continuation', undefined, first.id), /Only a returned/)
    f.state.gates.get(first.sessionId).release(); await until(() => f.api.getTask(first.id).status === 'completed')
    const continued = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'verify remaining work', undefined, first.id)
    await until(() => f.api.getTask(continued.id).status === 'completed')
    assert.equal(continued.sessionId, first.sessionId); assert.equal(continued.workspace.path, first.workspace.path)
    assert.equal(continued.sessionChoice.mode, 'continue'); assert.equal(continued.continuedFromTaskId, first.id)
    assert.equal(f.api.getTask(second.id).status, 'running', 'independent work is not interrupted by continuation')
    assert.equal(JSON.parse(await readFile(join(f.root, 'tasks', continued.id + '.json'), 'utf8')).workspace.path, first.workspace.path)
  } finally { await f.close() }
})

test('shared writers are serialized while independent work can run; dependencies wait without consuming a slot', async () => {
  const f = await fixture()
  try {
    const plan = { workspace: 'shared', workspace_reason: 'These tasks intentionally edit the same source files.' }
    const one = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'shared first', 'first', undefined, undefined, undefined, plan)
    await until(() => f.state.calls.some(call => call.id === one.sessionId))
    const two = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'shared second', 'second', undefined, undefined, undefined, plan)
    const independent = { workspace: 'isolated', workspace_reason: 'Truly independent scope so it runs in parallel with the serialized shared writers.' }
    const otherTask = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'independent work', 'independent', undefined, undefined, undefined, independent)
    await until(() => f.state.calls.some(value => value.id === otherTask.sessionId))
    const other = otherTask
    assert.equal(f.api.getTask(two.id).status, 'queued'); assert.equal(f.api.getTask(other.id).status, 'running')
    const dependency = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'consume output', 'dependent', undefined, undefined, undefined, { depends_on: [other.id] })
    assert.equal(f.api.getTask(dependency.id).status, 'queued')
    assert.deepEqual((await f.command({ action: 'inspect', taskId: dependency.id })).scheduling.waiting, [other.id])
    f.state.gates.get(one.sessionId).release(); await until(() => f.state.calls.some(call => call.id === two.sessionId))
    f.state.gates.get(other.sessionId).release(); await until(() => f.state.calls.some(call => call.id === dependency.sessionId))
    assert.equal(f.api.getTask(dependency.id).workspace.path, f.api.getTask(other.id).workspace.path)
  } finally { await f.close() }
})

test('lead can change queued priority and dependencies; running work and foreign Bots are protected', async () => {
  const f = await fixture()
  try {
    const blockerPlan = { workspace: 'isolated', workspace_reason: 'Each blocker fills an execution slot with its own scope.' }
    const blockers = []; for (let index = 0; index < 4; index++) blockers.push(await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'running-' + index, undefined, undefined, undefined, undefined, blockerPlan).then(async (task) => { await until(() => f.state.calls.some(value => value.id === task.sessionId)); return task }))
    const queued = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'ordinary work'), urgent = await f.api.delegateBackgroundTask(f.home.id, f.bot.id, f.bot.id, 'deadline work')
    assert.equal(f.api.getTask(urgent.id).status, 'queued')
    const updated = await f.command({ action: 'prioritize', taskId: urgent.id, priority: 'urgent', reason: 'The user moved this deadline ahead.' })
    assert.equal(updated.priority, 'urgent')
    await assert.rejects(f.command({ action: 'prioritize', taskId: blockers[0].id, priority: 'low', reason: 'change order' }), /Only queued/)
    const other = f.api.createBot({ name: 'Other', backendId: 'codex', modelId: 'fixture' })
    f.api.saveSession({ ...f.api.getSession(f.home.id), botIds: [f.bot.id, other.id] })
    await assert.rejects(f.command({ action: 'prioritize', taskId: urgent.id, priority: 'low', reason: 'foreign change' }, f.home.id, other.id), /does not belong/)
    f.state.gates.get(blockers[0].sessionId).release(); await until(() => f.api.getTask(urgent.id).status === 'running')
    assert.equal(f.api.getTask(queued.id).status, 'queued')
    assert.equal(f.state.stopped.length, 0, 'priority changes do not stop existing executions')
    const persisted = JSON.parse(await readFile(join(f.root, 'tasks', urgent.id + '.json'), 'utf8'))
    assert.equal(persisted.plan.priority, 'urgent')
    for (const blocker of blockers.slice(1)) assert.equal(f.api.getTask(blocker.id).status, 'running')
  } finally { await f.close() }
})
