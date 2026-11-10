import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('automatic task messages use the real deny/ask/semantic gate, persist refusals and reject stale permission cards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-communication-policy-')), before = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const s = globalThis.__communicationPolicy = { settings: { approvalPolicy: 'auto-run', automaticReview: true, allowlist: [], denylist: [], asklist: [] }, events: [], semanticCalls: 0 }
  const mocks = {
    '../settings': 'export const getSettings=()=>globalThis.__communicationPolicy.settings;export const onSettingsChanged=()=>()=>{}',
    './settingsGateway': 'export const settingsStore={get:async()=>globalThis.__communicationPolicy.settings,append:(k,v)=>globalThis.__communicationPolicy.settings[k].push(v)}',
    './events': 'export const broadcast=e=>globalThis.__communicationPolicy.events.push(e);export const broadcastError=()=>{}',
    './cancel': 'export const isRunning=()=>false;export const stopAfterRejectedApproval=()=>{throw Error("must not impersonate an execution turn")}',
    './semanticApproval': 'export const reviewApproval=async()=>{globalThis.__communicationPolicy.semanticCalls++;return {outcome:"deny",reason:"synthetic semantic refusal"}}',
    '../backends/vaultRedaction': 'export const redactSecrets=t=>t',
    './progressTurn': 'import {createHash} from "node:crypto";export const progressPermissionRevision=s=>createHash("sha256").update(JSON.stringify(s)).digest("hex")'
  }
  try {
    const outfile = join(root, 'case.mjs')
    await build({ stdin: { contents: `export * from './coordinationPermission.ts';export {respondToApproval,pendingCount} from '../agent/approval.ts'`, resolveDir: join(process.cwd(), 'src/main/tasks'), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'ordinary-approval-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
    } }] })
    const api = await import(pathToFileURL(outfile).href)
    let valid = true
    const base = { taskId: 'task', owner: 'source/bot/executor', sessionId: 'source', botId: 'bot', requestId: 'message-1', text: 'Check only the existing synthetic result.', kind: 'advise', signal: new AbortController().signal, valid: async () => valid }
    assert.equal(await api.authorizeCoordination(base), 'approved')
    assert.equal(s.events.length, 0, 'ordinary standing auto-run authorization adds no prompt')
    s.settings.denylist = ['tool:manage_task']
    assert.equal(await api.authorizeCoordination({ ...base, requestId: 'message-2' }), 'not-permitted')
    const denied = await api.communicationPermissionStatus('task')
    assert.equal(denied.state, 'denied')
    assert.equal(await api.authorizeCoordination({ ...base, requestId: 'new-report-is-not-consent' }), 'not-permitted')
    assert.equal(s.events.length, 0)
    s.settings.denylist = []; s.settings.asklist = ['tool:manage_task']
    const waitCard = async () => { for (let i = 0; i < 100; i++) { if (api.pendingCount()) return s.events.filter(e => e.type === 'approval-request').at(-1).request; await new Promise(r => setTimeout(r, 5)) } throw Error('No ordinary approval card') }
    let operation = api.authorizeCoordination({ ...base, requestId: 'message-3' }), card = await waitCard()
    assert.equal(card.sessionId, 'source'); assert.equal(card.toolName, 'manage_task'); assert.equal(card.kind, 'write'); assert.equal(card.force, true)
    api.respondToApproval(card.id, 'reject'); assert.equal(await operation, 'not-permitted')
    const count = s.events.length
    assert.equal(await api.authorizeCoordination({ ...base, requestId: 'message-4' }), 'not-permitted'); assert.equal(s.events.length, count)
    // Fresh module state as after restart must use the held durable refusal.
    await copyFile(outfile, join(root, 'restart.mjs'))
    const restarted = await import(pathToFileURL(join(root, 'restart.mjs')).href)
    assert.equal(await restarted.authorizeCoordination({ ...base, requestId: 'new-id-after-restart' }), 'not-permitted')
    assert.equal(s.events.length, count)
    assert.equal(JSON.parse(await readFile(join(root, 'task-communication-permissions/task.json'), 'utf8')).state, 'denied')
    s.settings.asklist = ['message']
    operation = api.authorizeCoordination({ ...base, requestId: 'message-5' }); card = await waitCard()
    valid = false; api.respondToApproval(card.id, 'approve-once'); assert.equal(await operation, 'deferred')
    valid = true; s.settings.asklist = []; s.settings.semanticPermissionRules = [{ id: 'test', version: 1, text: 'Synthetic semantic rule', effect: 'ask' }]
    assert.equal(await api.authorizeCoordination({ ...base, requestId: 'message-6' }), 'not-permitted'); assert.equal(s.semanticCalls, 1)
    s.settings.semanticPermissionRules = []
    assert.equal(await api.authorizeCoordination({ ...base, taskId: 'other' }), 'approved')
    const other = await api.communicationPermissionStatus('other')
    await writeFile(join(root, 'task-communication-permissions/other.json'), JSON.stringify({ ...other, state: 'checking' }))
    assert.equal(await api.authorizeCoordination({ ...base, taskId: 'other', requestId: 'after-crash' }), 'not-permitted')
    assert.equal(await api.authorizeCoordination({ ...base, owner: 'foreign' }), 'not-permitted')
    await writeFile(join(root, 'task-communication-permissions/task.json'), '{bad')
    assert.equal(await api.authorizeCoordination(base), 'not-permitted')
  } finally {
    if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before
    delete globalThis.__communicationPolicy; await rm(root, { recursive: true, force: true })
  }
})
