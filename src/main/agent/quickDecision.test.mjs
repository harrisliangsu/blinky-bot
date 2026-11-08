import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

let fixture
const output = await build({ entryPoints: [fileURLToPath(new URL('./quickDecision.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'only-inference-and-vault-boundaries', setup(b) {
  b.onResolve({ filter: /^\.\/backendGateway$/ }, () => ({ path: 'backend', namespace: 'fixture' }))
  b.onResolve({ filter: /^\.\.\/store\/vaultPrivacy$/ }, () => ({ path: 'vault', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'backend'
    ? 'export const getBackend=(...args)=>globalThis.__quickDecisionFixture.getBackend(...args); export const runSideCall=(...args)=>globalThis.__quickDecisionFixture.runSideCall(...args)'
    : 'export const scrubVaultJson=v=>JSON.parse(JSON.stringify(v).replaceAll("fixture-private","[redacted]")); export const scrubVaultTranscript=v=>v.replaceAll("fixture-private","[redacted]")', loader: 'js' }))
} }] })
const api = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
function reset(kind = 'cloud-api', id = 'fixture-api') {
  fixture = globalThis.__quickDecisionFixture = { calls: [], lookups: [], result: { text: '{"route":"delegate","reason":"Several steps"}', calls: [] }, getBackend: async id => { fixture.lookups.push(id); return { id, kind } }, runSideCall: async (...args) => { fixture.calls.push(args); return fixture.result } }
  return { settings: { backends: { [id]: { enabled: true } }, quickDecision: { backendId: id, modelId: 'routing-model' }, defaultModelId: 'lead-model' }, request: 'Do the work', context: [{ role: 'user', text: 'Prior settled context' }], cwd: '/fixture', signal: new AbortController().signal }
}

test('optional quick decision defaults off and never mutates lead/executor selection', async () => {
  const input = reset(); delete input.settings.quickDecision
  assert.equal(await api.quickDecisionHint(input), null); assert.equal(fixture.lookups.length, 0)
  input.settings.quickDecision = null
  assert.equal(await api.quickDecisionHint(input), null); assert.equal(fixture.lookups.length, 0)
  input.settings.quickDecision = { backendId: 'fixture-api', modelId: 'routing-model' }
  const before = JSON.stringify(input.settings)
  assert.deepEqual(await api.quickDecisionHint(input), { route: 'delegate', reason: 'Several steps' })
  assert.equal(JSON.stringify(input.settings), before)
  const request = fixture.calls[0][1]
  assert.equal(request.model, 'routing-model'); assert.equal(request.readOnly, true); assert.equal(request.disableNativeTools, true)
  for (const field of ['tools','mcpServers','sessionKey','approve','requestInput']) assert.equal(request[field], undefined)
  assert.equal(request.messages.length, 2)
})

test('actual adapter kind permits API/local-server/pi and rejects unproved native CLI paths', async () => {
  for (const [kind, id, allowed] of [['cloud-api','fixture-api',true],['local-server','fixture-local',true],['agent-cli','pi',true],['agent-cli','codex',false],['agent-cli','claude',false],['agent-cli','grok',false]]) {
    const input = reset(kind, id)
    assert.equal(Boolean(await api.quickDecisionHint(input)), allowed)
    assert.equal(fixture.calls.length, allowed ? 1 : 0)
  }
  const input = reset(); input.settings.backends['fixture-api'].enabled = false
  assert.equal(await api.quickDecisionHint(input), null); assert.equal(fixture.lookups.length, 0)
})

test('context and reasons use the vault scrub boundary before bounded serialization', async () => {
  const input = reset(); input.request = 'fixture-private ' + 'x'.repeat(5000)
  input.context = Array.from({ length: 10 }, () => ({ role: 'assistant', text: 'fixture-private ' + 'y'.repeat(1000) }))
  fixture.result = { text: JSON.stringify({ route: 'inline', reason: 'fixture-private\n' + 'z'.repeat(300) }), calls: [] }
  const hint = await api.quickDecisionHint(input), payload = JSON.parse(fixture.calls[0][1].messages[1].content)
  assert.equal(payload.request.length, 4000); assert.equal(payload.context.length, 4); assert.ok(payload.context.every(item => item.text.length === 800))
  assert.equal(JSON.stringify(payload).includes('fixture-private'), false)
  assert.ok(hint.reason.startsWith('[redacted] ')); assert.equal(hint.reason.length, 180); assert.equal(hint.reason.includes('\n'), false)
})

test('tool requests, errors, malformed or expanded output are discarded', async () => {
  for (const result of [null, { text: '{"route":"delegate","reason":"Run"}', calls: [{ name: 'shell' }] }, { text: 'not JSON', calls: [] }, { text: '{"route":"send","reason":"Run"}', calls: [] }, { text: '{"route":"inline","reason":""}', calls: [] }, { text: '{"route":"inline","reason":"Run","tool":"shell"}', calls: [] }]) {
    const input = reset(); fixture.result = result
    assert.equal(await api.quickDecisionHint(input), null)
  }
  const input = reset(); fixture.runSideCall = async () => { throw Error('Fixture provider failure') }
  assert.equal(await api.quickDecisionHint(input), null)
})

test('clarify is advice only and cannot generate questions or authorize actions', async () => {
  const input = reset(); fixture.result = { text: '{"route":"clarify","reason":"Destination is unspecified"}', calls: [] }
  assert.deepEqual(await api.quickDecisionHint(input), { route: 'clarify', reason: 'Destination is unspecified' })
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0][1].requestInput, undefined)
})

test('parent cancellation returns promptly even when inference ignores abort', async () => {
  const input = reset(), controller = new AbortController(); input.signal = controller.signal
  fixture.runSideCall = (...args) => { fixture.calls.push(args); return new Promise(() => {}) }
  const pending = api.quickDecisionHint(input)
  await Promise.resolve(); await Promise.resolve(); controller.abort()
  assert.equal(await pending, null); assert.equal(fixture.calls[0][1].signal.aborted, true)
  fixture.calls = []; assert.equal(await api.quickDecisionHint(input), null); assert.equal(fixture.calls.length, 0)
})

test('eight-second hard deadline silently falls back and aborts its side call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const input = reset()
  fixture.runSideCall = (...args) => { fixture.calls.push(args); return new Promise(() => {}) }
  const pending = api.quickDecisionHint(input)
  await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(api.QUICK_DECISION_TIMEOUT_MS)
  assert.equal(await pending, null); assert.equal(fixture.calls[0][1].signal.aborted, true)
})
