import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fixture, until } from './controlFixture.mjs'

const question = { id: 'directory', header: '目录', question: '此前指定的输出目录是什么？' }

test('original Bot answers only facts grounded verbatim in settled user context', async () => {
  const f = await fixture()
  try {
    const task = await f.start()
    const source = f.api.getSession(f.home.id)
    f.api.saveSession({ ...source, messages: [...source.messages, { id: 'user-fact', role: 'user', content: '输出目录使用 reports/weekly。', createdAt: Date.now() }] })
    f.state.answer = { text: JSON.stringify({ answers: { directory: { answer: 'reports/weekly', messageId: 'user-fact', quote: '输出目录使用 reports/weekly。' } } }), calls: [], reasoning: '' }
    assert.deepEqual(JSON.parse(JSON.stringify(await f.api.requestTaskClarification(task.sessionId, f.bot.id, [question], new AbortController().signal))), { directory: ['reports/weekly'] })
    const [request] = await f.api.listTaskClarifications(task.id)
    assert.equal(request.status, 'answered'); assert.equal(request.answeredBy, 'bot')
    assert.equal(f.state.sideCalls.length, 1); assert.equal(f.state.sideCalls[0][1].readOnly, true)
    assert.equal(f.state.sideCalls[0][0], 'codex')
    assert.equal(f.state.events.some(value => value.type === 'task-clarification-updated' && value.request.status === 'waiting_user'), false)
  } finally { await f.close() }
})

test('ungrounded suggestions fall through to a real card; duplicate answers never rerun a task', async () => {
  const f = await fixture()
  try {
    const task = await f.start(), controller = new AbortController()
    f.state.answer = { text: JSON.stringify({ answers: { directory: { answer: 'invented', messageId: 'missing', quote: 'invented' } } }), calls: [], reasoning: '' }
    const waiting = f.api.requestTaskClarification(task.sessionId, f.bot.id, [question], controller.signal)
    let request
    await until(async () => { [request] = await f.api.listTaskClarifications(task.id); return request?.status === 'waiting_user' })
    await until(() => f.state.events.some(value => value.type === 'task-clarification-updated' && value.request.status === 'waiting_user'))
    await assert.rejects(f.api.answerTaskClarification(request.id, {}), /Answer the current question/)
    const response = await f.api.answerTaskClarification(request.id, { directory: ['reports/confirmed'] })
    assert.equal(response.status, 'answered'); assert.equal(response.answeredBy, 'user')
    assert.deepEqual(JSON.parse(JSON.stringify(await waiting)), { directory: ['reports/confirmed'] })
    assert.equal((await f.api.answerTaskClarification(request.id, { directory: ['reports/confirmed'] })).status, 'answered')
    assert.equal(f.state.calls.length, 1)
  } finally { await f.close() }
})

test('authorization is never inferred, cancellation invalidates its question, and secrets stay out of records/events', async () => {
  const f = await fixture()
  try {
    const task = await f.start(), controller = new AbortController()
    let waiting = f.api.requestTaskClarification(task.sessionId, f.bot.id, [{ ...question, question: '是否授权发送邮件？' }], controller.signal)
    let request
    await until(async () => { request = (await f.api.listTaskClarifications(task.id)).find(value => value.status === 'waiting_user'); return request })
    assert.equal(f.state.sideCalls.length, 0)
    controller.abort()
    assert.equal(await waiting, null)
    await assert.rejects(f.api.answerTaskClarification(request.id, { directory: ['yes'] }), /失效/)
    assert.equal((await f.api.listTaskClarifications(task.id))[0].status, 'cancelled')
    waiting = f.api.requestTaskClarification(task.sessionId, f.bot.id, [{ ...question, isSecret: true, question: '输入临时口令' }], new AbortController().signal)
    await until(async () => { request = (await f.api.listTaskClarifications(task.id)).find(value => value.status === 'waiting_user'); return request })
    const secret = 'fixture-private-value-do-not-persist'
    const response = await f.api.answerTaskClarification(request.id, { directory: [secret] })
    assert.deepEqual(JSON.parse(JSON.stringify(await waiting)), { directory: [secret] })
    assert.deepEqual(response.answers.directory, ['[redacted]'])
    assert.equal((await readFile(join(f.root, 'task-clarifications', `${request.id}.json`), 'utf8')).includes(secret), false)
    assert.equal(JSON.stringify(f.state.events).includes(secret), false)
  } finally { await f.close() }
})

test('a fresh process expires clarification and uncertain delivery without replaying either request', async () => {
  const f = await fixture()
  try {
    const task = await f.start(), controller = new AbortController()
    const waiting = f.api.requestTaskClarification(task.sessionId, f.bot.id, [question], controller.signal)
    let request
    await until(async () => { [request] = await f.api.listTaskClarifications(task.id); return request?.status === 'waiting_user' })
    await f.command({ action: 'message', taskId: task.id, text: 'pending before shutdown', requestId: 'restart-1' })
    const code = `import {pathToFileURL} from 'node:url';globalThis.__taskControl={events:[]};const api=await import(pathToFileURL(${JSON.stringify(join(f.root, 'control.mjs'))}).href);await api.loadSessions();await api.loadTasks();const q=await api.listTaskClarifications(${JSON.stringify(task.id)});const m=await api.taskMessages(${JSON.stringify(task.id)});console.log(JSON.stringify({status:q[0].status,receipt:m[0].status}));`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, OPENBOT_DATA_DIR: f.root }, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 'expired', receipt: 'uncertain' })
    assert.equal(f.state.calls.length, 1)
    controller.abort(); await waiting
  } finally { await f.close() }
})
