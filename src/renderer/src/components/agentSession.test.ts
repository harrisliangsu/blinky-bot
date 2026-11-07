import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, AgentTask, Message, Session } from '../../../shared/types'
import { agentActivities, agentText, mergeAgentMessages, safeAgentCall, safeAgentResult, taskGroups, taskStatus } from './agentTaskPresentation'
import { observeAgentSession, type AgentSessionReadApi, type AgentSessionSnapshot } from './agentSessionReader'
import { summariseTask } from '../../../shared/activity'

const message = (id: string, patch: Partial<Message> = {}): Message => ({ id, role: 'assistant', content: id, createdAt: 1, ...patch })
const task = (id: string, status: string, patch: Partial<AgentTask> = {}): AgentTask => ({ id, status: status as AgentTask['status'], title: id, prompt: id, botId: 'bot', sessionId: 'exec', createdAt: 1, updatedAt: 1, ...patch })
const session = (messages: Message[] = []): Session => ({ id: 'exec', title: 'Execution', botIds: ['bot'], activeBotId: 'bot', cwd: '/isolated', mode: 'agent', todos: [], messages, createdAt: 1, updatedAt: 1 })
const tick = (ms = 65): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('task navigation drops bodies and evidence, preserving identity/status/review presence', () => {
 const summary=summariseTask(task('large','completed',{prompt:'private request',result:'private result',acceptance:{root:'/isolated',files:[]},review:{outcome:'complete_claimed',summary:'private review',evidence:['private evidence'],recordedAt:1}}))
 assert.equal(summary.hasReview,true);assert.equal(summary.id,'large');assert.equal(summary.status,'completed')
 for(const key of ['prompt','result','review','acceptance']) assert.equal(key in summary,false)
})

test('failed observation can retry; disposal releases only its observation', async () => {
 let fail=true;const watched:Array<string|null>=[],states:AgentSessionSnapshot[]=[]
 const reader=observeAgentSession({get:async()=>session(),live:async()=>[],on:()=>()=>{},watch:async id=>{watched.push(id);if(id&&fail)throw Error('watch failed')}},'exec','bot',state=>states.push(state))
 await tick();assert.equal(states.at(-1)?.phase,'error')
 fail=false;reader.refresh();await tick();assert.equal(states.at(-1)?.phase,'ready')
 reader.dispose();assert.deepEqual(watched,['exec','exec',null])
})

test('tabs include every nonterminal state, scope delegated tasks, and do not mutate input', () => {
  const values = [task('failed', 'failed'), task('queued', 'queued'), task('cancelled', 'cancelled'), task('running', 'running'), task('paused', 'paused'), task('done', 'completed'), task('future', 'waiting_for_approval'), task('foreign', 'running', { botId: 'other' }), task('delegated', 'running', { botId: 'worker', requesterBotId: 'bot' })]
  const before = structuredClone(values), groups = taskGroups(values, 'bot')
  assert.deepEqual(groups.active.map(item => item.id).sort(), ['delegated', 'future', 'paused', 'queued', 'running'])
  assert.deepEqual(groups.ended.map(item => item.id).sort(), ['cancelled', 'done', 'failed'])
  assert.deepEqual(values, before)
  assert.equal(taskStatus(task('done', 'completed'), true), '执行已结束')
  assert.equal(taskStatus(task('failed', 'failed'), false), 'Failed')
})

test('saved final outranks stale live, live updates streaming, internal/system/status messages stay private', () => {
  const saved = [message('final'), message('pending', { streaming: true }), message('secret', { internal: true }), message('system', { role: 'system' })]
  const live = [message('final', { content: 'stale', streaming: true }), message('pending', { content: 'new', streaming: true }), message('extra'), message('ui', { uiOnly: true })]
  const before = structuredClone({ saved, live }), merged = mergeAgentMessages(saved, live)
  assert.deepEqual(merged.map(item => [item.id, item.content]), [['final', 'final'], ['pending', 'new'], ['extra', 'extra']])
  assert.deepEqual({ saved, live }, before)
})

test('known native Codex activity becomes a command, real result and file diff without protocol fields', () => {
  const activities = agentActivities([message('steps', { agentTrace: [
    { id: 'cmd', kind: 'commandExecution', phase: 'started', detail: JSON.stringify({ command: ['printf', 'ok'], cwd: '/isolated', internalConfig: 'PRIVATE' }) },
    { id: 'cmd', kind: 'commandExecution', phase: 'completed', detail: JSON.stringify({ aggregatedOutput: 'ok', exitCode: 0 }) },
    { id: 'edit', kind: 'fileChange', phase: 'completed', detail: JSON.stringify({ status: 'completed', changes: [{ path: 'file.ts', diff: '@@ -1 +1 @@\n-old\n+new' }] }) }
  ] })], false)
  assert.equal(activities.length, 2)
  assert.equal(activities[0]!.call.args.command, 'printf ok')
  assert.equal(activities[0]!.status, 'ok')
  assert.equal(activities[0]!.result?.output, 'ok')
  assert.match(JSON.stringify(activities[1]!.result?.detail), /@@/)
  assert.doesNotMatch(JSON.stringify(activities), /PRIVATE|internalConfig/)
})

test('failed commands, missing exit status, historical unfinished tools and malformed traces stay distinct', () => {
  const activities = agentActivities([message('steps', { agentTrace: [
    { id: 'failed', kind: 'commandExecution', phase: 'completed', detail: '{"command":"false","exitCode":1}' },
    { id: 'missing', kind: 'commandExecution', phase: 'completed', detail: '{"command":"echo unknown","status":"completed"}' },
    { id: 'truncated', kind: 'mcpToolCall', phase: 'completed', detail: '{"private":"DO NOT PRINT' },
    { id: 'old', kind: 'commandExecution', phase: 'started', detail: '{"command":"old"}' }
  ] }), message('active', { streaming: true, agentTrace: [{ id: 'active', kind: 'commandExecution', phase: 'started', detail: '{"command":"current"}' }] })], true)
  assert.deepEqual(activities.map(item => item.status), ['failed', 'unknown', 'unknown', 'unknown', 'running'])
  assert.equal(activities[2]!.incomplete, true)
  assert.doesNotMatch(JSON.stringify(activities), /DO NOT PRINT/)
  assert.equal(agentActivities([message('a', { streaming: true, toolCalls: [{ id: 'app', name: 'shell', args: {} }] })], false)[0]!.status, 'unknown')
})

test('ACP completion with omitted kind coalesces by native id, preserving real args and output', () => {
  const activities = agentActivities([message('steps', { agentTrace: [
    { id: 'acp', kind: 'execute', phase: 'started', detail: '{"title":"Run command","rawInput":{"command":"pwd"},"status":"in_progress"}' },
    { id: 'acp', kind: 'kimi_tool', phase: 'completed', detail: '{"status":"failed","content":[{"type":"content","content":{"type":"text","text":"denied"}}]}' }
  ] })], false)
  assert.equal(activities.length, 1)
  assert.equal(activities[0]!.call.args.command, 'pwd')
  assert.equal(activities[0]!.result?.output, 'denied')
  assert.equal(activities[0]!.status, 'failed')
})

test('explicit native dynamic-tool failure outranks a completed transport status', () => {
  const activities = agentActivities([message('dynamic', { agentTrace: [{ id: 'dynamic', kind: 'dynamicToolCall', phase: 'completed', detail: '{"tool":"test_tool","status":"completed","success":false}' }] })], false)
  assert.equal(activities[0]!.status, 'failed')
  assert.equal(activities[0]!.result?.ok, false)
})

test('private fields are redacted and action payloads/screenshots are not passed to rich tools', () => {
  const call = safeAgentCall({ id: 'a', name: 'shell', args: { password: 'SYNTHETIC_SECRET', nested: { api_key: 'SYNTHETIC_KEY' }, command: 'token=SYNTHETIC_TOKEN echo ok' } })
  const result = safeAgentResult({ callId: 'a', name: 'shell', ok: false, output: 'password=SYNTHETIC_SECRET', screenshot: 'PRIVATE_IMAGE', screenshotRef: 'PRIVATE_REF', detail: { visualization: { secret: 'ACTION' }, path: 'safe.ts', diff: '@@' } })
  assert.doesNotMatch(JSON.stringify({ call, result }), /SYNTHETIC_|PRIVATE_|ACTION/)
  assert.equal((result.detail as { path: string }).path, 'safe.ts')
  assert.match(agentText('Authorization: Bearer abcdefghijklmnop'), /redacted/)
  assert.doesNotMatch(agentText('password="PRIVATE pass phrase"\nAuthorization: Basic PRIVATE_HEADER\nCookie: PRIVATE_COOKIE; session=PRIVATE_SESSION\n{"api_key":"PRIVATE JSON value"}\n-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_PEM\n-----END RSA PRIVATE KEY-----'), /PRIVATE/)
  assert.equal(agentActivities([message('internal', { internal: true, toolResult: { callId: 'private', name: 'secret', ok: true, output: 'PRIVATE' } })], false).length, 0)
})

function fixture() {
  let saved: Session | null = session([message('saved')]), live: Message[] = [], failSaved = false, failLive = false, reads = 0
  const listeners = new Set<(event: AgentEvent) => void>(), snapshots: AgentSessionSnapshot[] = []
  const api: AgentSessionReadApi = {
    get: async id => { assert.equal(id, 'exec'); reads++; if (failSaved) throw new Error('read failure'); return structuredClone(saved) },
    live: async id => { assert.equal(id, 'exec'); if (failLive) throw new Error('live failure'); return structuredClone(live) },
    on: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const reader = observeAgentSession(api, 'exec', 'bot', value => snapshots.push(value))
  return { reader, listeners, snapshots, emit: (event: AgentEvent) => listeners.forEach(listener => listener(event)), setSaved: (value: Session | null) => { saved = value }, setLive: (value: Message[]) => { live = value }, fail: (store: boolean, streaming = false) => { failSaved = store; failLive = streaming }, reads: () => reads }
}

test('read-only observer follows scoped live snapshots and final commits without duplicate deltas', async () => {
  const f = fixture()
  try {
    await tick()
    assert.equal(f.snapshots.at(-1)?.phase, 'ready')
    const before = f.reads()
    f.emit({ type: 'text-delta', sessionId: 'other', messageId: 'live', delta: 'secret' })
    await tick()
    assert.equal(f.reads(), before)
    f.setLive([message('live', { content: 'AB', segments: [{ id: 'answer', phase: 'partial_answer', text: 'AB' }], streaming: true })])
    f.emit({ type: 'text-delta', sessionId: 'exec', messageId: 'live', delta: 'B' })
    f.emit({ type: 'text-delta', sessionId: 'exec', messageId: 'live', delta: 'B' })
    await tick()
    assert.equal(f.snapshots.at(-1)?.messages.at(-1)?.content, 'AB')
    f.setSaved(session([message('saved'), message('live', { content: 'Final' })])); f.setLive([])
    f.emit({ type: 'done', sessionId: 'exec' })
    await tick()
    assert.deepEqual(f.snapshots.at(-1)?.messages.map(item => item.content), ['saved', 'Final'])
  } finally { f.reader.dispose() }
  assert.equal(f.listeners.size, 0)
  const count = f.snapshots.length
  f.reader.refresh(); await tick()
  assert.equal(f.snapshots.length, count)
})

test('missing, foreign, failed and partial-live reads have separate states and keep no foreign content', async () => {
  const f = fixture()
  try {
    await tick()
    f.fail(false, true); f.reader.refresh(); await tick()
    assert.equal(f.snapshots.at(-1)?.liveUnavailable, true)
    assert.equal(f.snapshots.at(-1)?.messages.length, 1)
    f.fail(true); f.reader.refresh(); await tick()
    assert.equal(f.snapshots.at(-1)?.phase, 'error')
    assert.equal(f.snapshots.at(-1)?.messages.length, 1)
    f.fail(false); f.setSaved(null); f.reader.refresh(); await tick()
    assert.equal(f.snapshots.at(-1)?.phase, 'missing')
    f.setSaved({ ...session([message('PRIVATE')]), botIds: ['other'] }); f.setLive([message('PRIVATE_LIVE')]); f.reader.refresh(); await tick()
    assert.equal(f.snapshots.at(-1)?.phase, 'unavailable')
    assert.deepEqual(f.snapshots.at(-1)?.messages, [])
    f.setSaved(session()); f.setLive([]); f.reader.refresh(); await tick()
    assert.equal(f.snapshots.at(-1)?.phase, 'ready')
    assert.deepEqual(f.snapshots.at(-1)?.messages, [])
  } finally { f.reader.dispose() }
})

test('events during an in-flight read are not lost; disposed late replies never publish', async () => {
  let resolveGet!: (value: Session | null) => void, count = 0, listener!: (event: AgentEvent) => void
  const states: AgentSessionSnapshot[] = []
  const reader = observeAgentSession({
    get: () => ++count === 1 ? new Promise(resolve => { resolveGet = resolve }) : Promise.resolve(session([message('updated')])),
    live: async () => [], on: callback => { listener = callback; return () => {} }
  }, 'exec', 'bot', value => states.push(value))
  listener({ type: 'done', sessionId: 'exec' }); await tick()
  resolveGet(session()); await tick(120)
  assert.equal(states.at(-1)?.messages[0]?.content, 'updated')
  reader.dispose()
  let resolveLate!: (value: Session | null) => void
  const late: AgentSessionSnapshot[] = []
  const second = observeAgentSession({ get: () => new Promise(resolve => { resolveLate = resolve }), live: async () => [], on: () => () => {} }, 'exec', 'bot', value => late.push(value))
  await tick(0)
  second.dispose(); resolveLate(session([message('too-late')])); await tick()
  assert.deepEqual(late.map(item => item.phase), ['loading'])
})

test('streaming only reads live buffer; saved history is read again at commit', async () => {
  const f = fixture()
  try {
    await tick()
    const initial = f.reads()
    f.setLive([message('live', { streaming: true, content: 'incremental' })])
    for (let i=0;i<5;i++) { f.emit({ type:'text-delta', sessionId:'exec', messageId:'live', delta:'ignored duplicate' }); await tick() }
    assert.equal(f.reads(), initial)
    assert.equal(f.snapshots.at(-1)?.messages.at(-1)?.content, 'incremental')
    f.setSaved(session([message('saved'), message('live', { content: 'committed' })])); f.setLive([])
    f.emit({ type:'message-end', sessionId:'exec', messageId:'live', content:'committed' }); await tick()
    assert.equal(f.reads(), initial + 1)
    assert.equal(f.snapshots.at(-1)?.messages.at(-1)?.content, 'committed')
  } finally { f.reader.dispose() }
})
