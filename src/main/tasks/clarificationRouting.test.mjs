import assert from 'node:assert/strict'
import { writeFile, readFile, rename, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture as baseFixture, until } from './controlFixture.mjs'
const fixture = async () => { const f = await baseFixture(); const source = f.api.getSession(f.home.id); f.api.saveSession({ ...source, messages: [...source.messages, { id: 'user-objective', role: 'user', content: '生成一个内部报告，常规可逆细节自行决定。', createdAt: Date.now() }] }); return f }
const preference = { id: 'audience', header: '受众', question: '这份方案主要给谁看？', kind: 'preference', options: [{ label: '客户', description: '面向外部客户' }, { label: '团队', description: '内部协作' }] }
const implementation = { id: 'format', header: '格式', question: '内部临时报告使用什么格式？', kind: 'implementation' }
const waiting = async f => { let r; await until(async () => { r = (await f.api.listTaskClarifications()).find(x => x.status === 'waiting_user'); return r }); return r }
const plain = x => JSON.parse(JSON.stringify(x))

test('Bot direct question returns a free-text answer only to the original turn; ordinary text creates no card', async () => {
 const f = await fixture()
 try {
  f.reply(f.home.id, '普通回复也可以有问号？')
  assert.equal((await f.api.listTaskClarifications()).length, 0)
  const controller = new AbortController()
  const answer = f.api.requestTaskClarification(f.home.id, f.bot.id, [preference], controller.signal, 'bot-direct')
  const r = await waiting(f)
  assert.equal(r.sourceSessionId, f.home.id); assert.equal(r.executionSessionId, f.home.id)
  assert.equal(f.state.sideCalls.length, 0)
  await f.api.answerTaskClarification(r.id, { audience: ['技术评审组'] })
  assert.deepEqual(plain(await answer), { audience: ['技术评审组'] })
 } finally { await f.close() }
})

test('owning Bot decides a reversible Agent detail and labels it as implementation, not user consent', async () => {
 const f = await fixture()
 try {
  const t = await f.start('生成一个临时内部报告，自行处理常规细节')
  f.state.answer = { text: JSON.stringify({ answers: { format: { kind: 'decision', answer: 'Markdown', reason: '本地临时报告，可随时转换格式，不改变目标', routineReversible: true, requiresUserAuthorization: false } } }), calls: [] }
  const answer = await f.api.requestTaskClarification(t.sessionId, f.bot.id, [implementation], new AbortController().signal, 'routine-choice')
  assert.deepEqual(plain(answer), { format: ['Markdown'] })
  const [r] = await f.api.listTaskClarifications(t.id)
  assert.equal(r.answeredBy, 'bot'); assert.equal(r.answerBasis, 'implementation')
  assert.equal(f.state.events.some(x => x.request?.status === 'waiting_user'), false)
 } finally { await f.close() }
})

test('partial Bot answers ask the user only unresolved questions and merge one exact executor response', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), controller = new AbortController()
  f.state.answer = { text: JSON.stringify({ answers: { format: { kind: 'decision', answer: 'Markdown', reason: '本地可逆格式', routineReversible: true, requiresUserAuthorization: false } } }), calls: [] }
  const answer = f.api.requestTaskClarification(t.sessionId, f.bot.id, [implementation, preference], controller.signal, 'partial')
  const r = await waiting(f)
  assert.deepEqual(r.questions.filter(q => !r.botAnswers?.[q.id]).map(q => q.id), ['audience'])
  await f.api.answerTaskClarification(r.id, { audience: ['团队'] })
  assert.deepEqual(plain(await answer), { format: ['Markdown'], audience: ['团队'] })
 } finally { await f.close() }
})

test('same logical request coalesces before and after answer; conflicting reuse is refused', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), controller = new AbortController()
  const a = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal, 'dedup')
  const b = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal, 'dedup')
  const r = await waiting(f)
  assert.equal((await f.api.listTaskClarifications()).length, 1)
  await assert.rejects(f.api.requestTaskClarification(t.sessionId, f.bot.id, [implementation], controller.signal, 'dedup'), /different questions/)
  await f.api.answerTaskClarification(r.id, { audience: ['客户'] })
  assert.deepEqual(plain(await a), plain(await b))
  assert.deepEqual(plain(await f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal, 'dedup')), { audience: ['客户'] })
  assert.equal((await f.api.listTaskClarifications()).length, 1)
 } finally { await f.close() }
})

test('explicit question cancellation returns no answer; duplicate cancellation and re-delivery never re-ask', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), controller = new AbortController()
  const a = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal, 'cancel')
  const r = await waiting(f)
  assert.equal((await f.api.cancelTaskClarification(r.id)).status, 'cancelled')
  assert.equal(await a, null)
  assert.equal((await f.api.cancelTaskClarification(r.id)).status, 'cancelled')
  await assert.rejects(f.api.answerTaskClarification(r.id, { audience: ['客户'] }))
  assert.equal(await f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal, 'cancel'), null)
 } finally { await f.close() }
})

test('preference cannot be invented as routine decision; authorization never reaches automatic decision', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), controller = new AbortController()
  f.state.answer = { text: JSON.stringify({ answers: { audience: { kind: 'decision', answer: '客户', reason: '猜测', routineReversible: true, requiresUserAuthorization: false } } }), calls: [] }
  const a = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], controller.signal)
  const r = await waiting(f); await f.api.cancelTaskClarification(r.id); await a
  const before = f.state.sideCalls.length
  const b = f.api.requestTaskClarification(t.sessionId, f.bot.id, [{ ...preference, kind: 'authorization', question: '是否授权发给外部客户？' }], controller.signal)
  const r2 = await waiting(f)
  assert.equal(f.state.sideCalls.length, before)
  await f.api.cancelTaskClarification(r2.id); assert.equal(await b, null)
 } finally { await f.close() }
})

test('unavailable durable storage does not continue or fabricate an answer', async () => {
 const f = await fixture()
 try {
  await writeFile(join(f.root, 'task-clarifications'), 'not a directory')
  assert.equal(await f.api.requestTaskClarification(f.home.id, f.bot.id, [preference], new AbortController().signal), null)
 } finally { await f.close() }
})

test('MCP retries with distinct request signals share the grant identity and never duplicate a card', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), identity = new AbortController(), first = new AbortController(), retry = new AbortController()
  const a = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], first.signal, 'message:stable', identity.signal)
  const b = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], retry.signal, 'message:stable', identity.signal)
  const r = await waiting(f)
  assert.equal((await f.api.listTaskClarifications()).length, 1)
  await f.api.answerTaskClarification(r.id, { audience: ['团队'] })
  assert.deepEqual(plain(await a), plain(await b))
 } finally { await f.close() }
})

test('tool replies identify Bot decisions so they cannot masquerade as user consent', async () => {
 const f = await fixture()
 try {
  const t = await f.start()
  f.state.answer = { text: JSON.stringify({ answers: { format: { kind: 'decision', answer: 'Markdown', reason: '本机可逆格式', routineReversible: true, requiresUserAuthorization: false } } }), calls: [] }
  const reply = await f.api.requestToolClarification(t.sessionId, f.bot.id, [implementation], new AbortController().signal, 'metadata')
  assert.equal(reply.answeredBy, 'bot'); assert.equal(reply.answerBasis, 'implementation')
  assert.deepEqual(plain(reply.botAnsweredQuestions), ['format'])
 } finally { await f.close() }
})

const factQuestion = { id: 'directory', header: '目录', question: '此前指定的输出目录是什么？', kind: 'fact' }
const factReply = (answer, messageId, quote, extra = {}) => ({ text: JSON.stringify({ answers: { directory: { kind: 'fact', answer, messageId, quote, ...extra } } }), calls: [] })
const append = (f, sessionId, message) => { const s = f.api.getSession(sessionId); f.api.saveSession({ ...s, messages: [...s.messages, message] }) }

test('foreign Bot observations are excluded rather than reclassified as user facts', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), c = new AbortController()
  append(f, f.home.id, { id: 'foreign', role: 'tool', botId: 'other-bot', content: 'reports/other-task', toolResult: { callId: 'foreign-call', name: 'shell', ok: true, output: 'reports/other-task' }, createdAt: 2 })
  f.state.answer = factReply('reports/other-task', 'foreign', 'reports/other-task')
  const run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [factQuestion], c.signal)
  const r = await waiting(f)
  assert.deepEqual(JSON.parse(f.state.sideCalls[0][1].messages[1].content).observations, [])
  assert.equal(r.answeredBy, undefined)
  await f.api.cancelTaskClarification(r.id); assert.equal(await run, null)
 } finally { await f.close() }
})

test('owned tool evidence needs exact session/tool/call identity and remains an observation', async () => {
 const f = await fixture()
 try {
  const t = await f.start()
  append(f, t.sessionId, { id: 'own-tool', role: 'tool', botId: f.bot.id, content: 'reports/observed', toolResult: { callId: 'own-call', name: 'list_dir', ok: true, output: 'reports/observed' }, createdAt: 3 })
  f.state.answer = factReply('reports/observed', 'own-tool', 'reports/observed')
  const first = f.api.requestTaskClarification(t.sessionId, f.bot.id, [factQuestion], new AbortController().signal)
  const r = await waiting(f); await f.api.cancelTaskClarification(r.id); assert.equal(await first, null)
  f.state.answer = factReply('reports/observed', 'own-tool', 'reports/observed', { sourceKind: 'tool', sessionId: t.sessionId, toolName: 'list_dir', callId: 'own-call' })
  const answer = await f.api.requestToolClarification(t.sessionId, f.bot.id, [factQuestion], new AbortController().signal)
  assert.deepEqual(plain(answer.answers), { directory: ['reports/observed'] })
  assert.equal(answer.answerEvidence.directory.kind, 'tool_observation')
  assert.equal(answer.answerEvidence.directory.callId, 'own-call')
  const record = (await f.api.listTaskClarifications(t.id)).find(x => x.status === 'answered')
  assert.equal(record.answerEvidence.directory.sessionId, t.sessionId)
 } finally { await f.close() }
})

test('new user correction during a side call gets one fresh attempt and cannot return the old answer', async () => {
 const f = await fixture()
 try {
  const t = await f.start()
  append(f, f.home.id, { id: 'old', role: 'user', content: '输出目录 reports/old', createdAt: 2 })
  let release; f.state.answer = new Promise(resolve => { release = resolve })
  const run = f.api.requestToolClarification(t.sessionId, f.bot.id, [factQuestion], new AbortController().signal)
  await until(() => f.state.sideCalls.length === 1)
  append(f, f.home.id, { id: 'new', role: 'user', content: '更正为 reports/new', createdAt: 3 })
  f.state.answer = factReply('reports/new', 'new', '更正为 reports/new')
  release(factReply('reports/old', 'old', '输出目录 reports/old'))
  const answer = await run
  assert.deepEqual(plain(answer.answers), { directory: ['reports/new'] })
  assert.equal(f.state.sideCalls.length, 2); assert.equal(answer.answerEvidence.directory.messageId, 'new')
 } finally { await f.close() }
})

test('typed authorization never reaches the model even when the text lacks permission keywords', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [{ ...preference, kind: 'authorization', question: '下一步选哪一个？' }], new AbortController().signal)
  const r = await waiting(f); assert.equal(f.state.sideCalls.length, 0)
  await f.api.cancelTaskClarification(r.id); assert.equal(await run, null)
 } finally { await f.close() }
})

test('unknown model result kind cannot smuggle a tool quote into a fact', async () => {
 const f = await fixture()
 try {
  const t = await f.start(); append(f, f.home.id, { id: 'fact-row', role: 'user', content: 'reports/weekly', createdAt: 2 })
  f.state.answer = factReply('reports/weekly', 'fact-row', 'reports/weekly', { kind: 'authorization' })
  const run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [factQuestion], new AbortController().signal)
  const r = await waiting(f); await f.api.cancelTaskClarification(r.id); assert.equal(await run, null)
 } finally { await f.close() }
})

test('stop immediately after an automatic answer write never returns that answer', async () => {
 const f = await fixture(); let release
 try {
  const t = await f.start(), c = new AbortController(), held = new Promise(resolve => { release = resolve })
  append(f, f.home.id, { id: 'fact', role: 'user', content: 'reports/weekly', createdAt: 2 })
  f.state.answer = factReply('reports/weekly', 'fact', 'reports/weekly')
  f.state.beforeClarificationWrite = async r => { if (r.status === 'cancelled') await held }
  f.state.afterClarificationWrite = r => { if (r.status === 'answered') { c.abort(); setTimeout(release, 10) } }
  const run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [factQuestion], c.signal)
  assert.equal(await run, null)
  assert.equal((await f.api.listTaskClarifications(t.id))[0].status, 'cancelled')
  assert.equal(f.state.events.some(e => e.request?.status === 'answered'), false)
 } finally { release?.(); await f.close() }
})

test('a real cancellation write failure stays closed in readback and exposes a persistence warning', async () => {
 const f = await fixture(); let file
 try {
  const t = await f.start(), c = new AbortController(), run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], c.signal)
  const r = await waiting(f); file = join(f.root, 'task-clarifications', r.id + '.json')
  await rename(file, file + '.original'); await mkdir(file)
  const receipt = await f.api.cancelTaskClarification(r.id)
  assert.equal(receipt.status, 'cancelled'); assert.ok(receipt.persistenceError)
  assert.equal(await run, null)
  await rmdir(file); await rename(file + '.original', file)
  const disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(disk.request.status, 'waiting_user')
  assert.equal((await f.api.listTaskClarifications(t.id))[0].status, 'cancelled')
  await assert.rejects(f.api.answerTaskClarification(r.id, { audience: ['客户'] }))
  assert.equal(await f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], c.signal), null)
  const retried = await f.api.cancelTaskClarification(r.id); assert.equal(retried.status, 'cancelled'); assert.equal(retried.persistenceError, undefined)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).request.status, 'cancelled'); file = undefined
 } finally { if (file) { await rmdir(file).catch(() => {}); await rename(file + '.original', file).catch(() => {}) }; await f.close() }
})

test('an answer write failure concurrent with stop cannot restore waiting state', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), c = new AbortController(), run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], c.signal)
  const r = await waiting(f)
  f.state.beforeClarificationWrite = request => { if (request.status === 'answered') { c.abort(); throw Error('synthetic failed answer write') } }
  await assert.rejects(f.api.answerTaskClarification(r.id, { audience: ['客户'] }))
  assert.equal(await run, null)
  assert.equal((await f.api.listTaskClarifications(t.id))[0].status, 'cancelled')
 } finally { await f.close() }
})

test('changing only request_id cannot re-ask a cancelled question without new user context', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), identity = new AbortController()
  const a = f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], new AbortController().signal, 'first', identity.signal)
  const r = await waiting(f); await f.api.cancelTaskClarification(r.id); assert.equal(await a, null)
  assert.equal(await f.api.requestTaskClarification(t.sessionId, f.bot.id, [preference], new AbortController().signal, 'new-id-only', identity.signal), null)
  assert.equal((await f.api.listTaskClarifications(t.id)).length, 1)
 } finally { await f.close() }
})

test('a user reply cannot merge with a partial Bot answer from an older context', async () => {
 const f = await fixture()
 try {
  const t = await f.start(), c = new AbortController()
  f.state.answer = { text: JSON.stringify({ answers: { format: { kind: 'decision', answer: 'Markdown', reason: '本机可逆格式', routineReversible: true, requiresUserAuthorization: false } } }), calls: [] }
  const run = f.api.requestTaskClarification(t.sessionId, f.bot.id, [implementation, preference], c.signal)
  const r = await waiting(f)
  append(f, f.home.id, { id: 'correction', role: 'user', content: '更正，临时报告格式用 HTML。', createdAt: 3 })
  await assert.rejects(f.api.answerTaskClarification(r.id, { audience: ['团队'] }), /上下文已更新/)
  assert.equal(await run, null)
  const current = (await f.api.listTaskClarifications(t.id))[0]
  assert.equal(current.status, 'expired'); assert.equal(current.answers, undefined)
 } finally { await f.close() }
})

for (const [failure, reason] of [
 ['This native CLI side call requires a user decision and was skipped.', 'permission-required'],
 ['Codex cannot safely disable its native host tools for this target', 'native-tools-unavailable'],
 ['Never allow', 'local-execution-denied'],
 ['provider failure with private details', 'inference-unavailable']
]) test(`owning Bot inference unavailability is visible, unanswered and associated: ${reason}`, async () => {
 const f = await fixture()
 try {
  const t = await f.start(), controller = new AbortController()
  f.state.sideCallError = failure
  const answer = f.api.requestTaskClarification(t.sessionId, f.bot.id, [implementation], controller.signal, 'unavailable')
  const r = await waiting(f)
  assert.equal(r.botResolutionUnavailable, reason)
  assert.equal(r.sourceSessionId, f.home.id); assert.equal(r.executionSessionId, t.sessionId)
  assert.equal(r.answeredBy, undefined); assert.equal(r.answers, undefined)
  assert.equal(JSON.stringify(r).includes('private details'), false)
  await f.api.answerTaskClarification(r.id, { format: ['Markdown'] })
  assert.deepEqual(plain(await answer), { format: ['Markdown'] })
  assert.equal((await f.api.listTaskClarifications(t.id))[0].answeredBy, 'user')
 } finally { await f.close() }
})
