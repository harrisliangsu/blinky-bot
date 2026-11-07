/** Actual stream/event/live snapshot/SQLite boundaries; virtual crypto only. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = process.cwd(), work = await mkdtemp(join(tmpdir(), 'blinky-vault-stream-'))
const plan = JSON.parse(await readFile(join(repo, 'docs/validation/vault-stream-patch-input.json'), 'utf8'))
let applied = false
const bundle = await build({ stdin: { resolveDir: repo, contents: `
export * as vault from './src/main/store/vault';
export * as privacy from './src/main/store/vaultPrivacy';
export * as events from './src/main/agent/events';
export {liveMessages} from './src/main/agent/liveMessages';
export {streamAssistantTurn} from './src/main/agent/stream';
export {SessionDatabase} from './src/main/store/sessionDatabase';
` }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [{ name: 'isolated-stream-boundary', setup(b) {
  b.onLoad({ filter: /\/agent\/events\.ts$/ }, async ({ path }) => {
    const source = await readFile(path, 'utf8')
    applied = source === plan.candidateSource
    assert.equal(applied, true, 'The actual event source must be wired; this test never applies a candidate.')
    return undefined
  })
  b.onLoad({ filter: /\/agent\/optionalModules\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace(/import\.meta\.glob\('[^']+'\)/g, '{}'), loader: 'ts' }))
  b.onResolve({ filter: /^\.\.\/ipc\/broadcast$/ }, ({ importer }) => importer.endsWith('/agent/events.ts') ? { path: 'windows', namespace: 'fixture' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const broadcast=event=>globalThis.__vaultWindowEvents.push(structuredClone(event))', loader: 'js' }))
  b.onResolve({ filter: /^electron$/ }, () => { throw new Error('Node fixture must not load Electron.') })
} }] })
after(async () => { await rm(work, { recursive: true, force: true }) })

async function fixture(run) {
  const root = await mkdtemp(join(work, 'case-')), module = join(root, 'module.mjs')
  await writeFile(module, bundle.outputFiles[0].text)
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const api = await import(pathToFileURL(module).href), key = randomBytes(32)
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value,'utf8'), cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]) },
    decryptString: value => { const cipher = createDecipheriv('aes-256-gcm',key,value.subarray(0,12)); cipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8') }
  }
  api.vault.setVaultStorageForTests(fake)
  globalThis.__vaultWindowEvents = []
  const seen = [], stop = api.events.onAgentEvent(event => seen.push(structuredClone(event)))
  const secret = 'Fixture🧪private/4826', item = await api.vault.addVaultItem({ kind: 'login', label: 'Virtual', origin: 'https://fixture.invalid', values: { password: secret } })
  try { await run({ api, root, fake, secret, item, seen, windows: globalThis.__vaultWindowEvents }) }
  finally { stop(); api.vault.setVaultStorageForTests(undefined); delete globalThis.__vaultWindowEvents; if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous }
}
const eventText = (events, type = 'text-delta') => events.filter(e => e.type === type).map(e => e.delta).join('')
const start = (api, sessionId = 's', messageId = 'm') => api.events.broadcast({ type: 'message-start', sessionId, message: { id: messageId, role: 'assistant', createdAt: 0, content: '', streaming: true } })
const delta = (api, text, segment, sessionId = 's', messageId = 'm') => api.events.broadcast({ type: 'text-delta', sessionId, messageId, delta: text, ...(segment ? { segment } : {}) })

test('every split, single code-unit chunks and replay-style events are safe before listeners, windows and live snapshots', async () => fixture(async ({ api, secret, seen, windows }) => {
  for (let cut = 1; cut < secret.length; cut++) {
    seen.length = 0; windows.length = 0; start(api)
    delta(api, 'ordinary ' + secret.slice(0,cut))
    assert.equal(eventText(seen), 'ordinary ')
    assert.equal(api.liveMessages('s')[0].content, 'ordinary ')
    delta(api, secret.slice(cut) + ' suffix')
    api.events.broadcast({ type: 'done', sessionId: 's' })
    assert.equal(eventText(seen), 'ordinary [vault value] suffix')
    assert.deepEqual(windows, seen)
  }
  seen.length = 0; start(api)
  for (const char of secret.split('')) delta(api, char)
  api.events.broadcast({ type: 'done', sessionId: 's' })
  assert.equal(eventText(seen), '[vault value]')
}))

test('cross-segment matches and transcript-only prefixes preserve phases without exposing raw snapshots', async () => fixture(async ({ api, secret, seen }) => {
  start(api)
  const first = secret.slice(0,9), second = secret.slice(9)
  delta(api, '\n\n' + first, { id: 'comment', phase: 'commentary', delta: first, text: first })
  delta(api, second + ' answer', { id: 'answer', phase: 'final_answer', delta: second + ' answer', text: secret + ' answer' })
  assert.equal(eventText(seen), '\n\n[vault value] answer')
  const live = api.liveMessages('s')[0]
  assert.deepEqual(live.segments, [{ id: 'comment', phase: 'commentary', text: '[vault value]' }, { id: 'answer', phase: 'final_answer', text: ' answer' }])
  assert.ok(!JSON.stringify(seen).includes(secret)); assert.ok(!JSON.stringify(live).includes(first))
  const projected = api.privacy.scrubVaultMessage({ id: 'm', role: 'assistant', content: secret, createdAt: 0, segments: [{ id: 'a', phase: 'commentary', text: first }, { id: 'b', phase: 'final_answer', text: second }] })
  assert.equal(projected.segments.map(s => s.text).join(''), '[vault value]')
}))

test('actual stream keeps executable protocol while projected checkpoints and SQLite contain safe copies', async () => fixture(async ({ api, root, secret, seen }) => {
  const db = new api.SessionDatabase(join(root, 'sessions.sqlite')), controller = new AbortController()
  const raw = 'ACTION {"value":"' + secret + '"}'
  const call = { id: 'c', name: 'fixture', args: { value: secret } }
  start(api)
  const checkpoints = []
  try {
    const result = await api.streamAssistantTurn({ sessionId: 's', messageId: 'm', signal: controller.signal,
      stream: (async function* () { yield { type: 'text', delta: raw.slice(0,28) }; yield { type: 'reasoning', delta: secret.slice(0,7) }; yield { type: 'text', delta: raw.slice(28) }; yield { type: 'reasoning', delta: secret.slice(7) + '.' }; yield { type: 'tool_call', call }; yield { type: 'done' } })(),
      onCheckpoint: async partial => { const message = api.privacy.scrubVaultMessage({ id: 'm', role: 'assistant', content: partial.text, reasoning: partial.reasoning, toolCalls: partial.calls, agentTrace: partial.agentTrace, createdAt: 0 }); checkpoints.push(message); db.put({ id: 's', title: 'Virtual', messages: [message], createdAt: 0, updatedAt: 0 }) }
    })
    assert.equal(result.text, raw, 'internal ACTION parsing must see its original parameters')
    assert.equal(result.calls[0].args.value, secret)
    assert.equal(call.args.value, secret)
    const safe = api.privacy.scrubVaultMessage({ id: 'm', role: 'assistant', content: result.text, reasoning: result.reasoning, createdAt: 0, toolCalls: result.calls })
    db.put({ id: 's', title: 'Virtual', messages: [safe], createdAt: 0, updatedAt: 0 })
    api.events.broadcast({ type: 'message-end', sessionId: 's', messageId: 'm', content: safe.content })
    assert.ok(!JSON.stringify(seen).includes(secret)); assert.ok(!JSON.stringify(checkpoints).includes(secret.slice(0,7)))
    assert.ok(!JSON.stringify(db.get('s')).includes(secret))
    assert.equal(eventText(seen, 'reasoning-delta'), '[vault value].')
  } finally { db.close() }
}))

test('EOF, abort and error flush an ambiguous prefix as a marker and clear only their own message', async () => fixture(async ({ api, secret, seen }) => {
  start(api); start(api, 'other', 'other-m')
  delta(api, secret.slice(0,8)); delta(api, 'independent', undefined, 'other', 'other-m')
  assert.equal(eventText(seen.filter(e => e.sessionId === 's')), '')
  api.events.broadcast({ type: 'error', sessionId: 's', message: 'aborted' })
  assert.equal(eventText(seen.filter(e => e.sessionId === 's')), '[vault value]')
  assert.equal(api.liveMessages('other')[0].content, 'independent')
  assert.equal(api.privacy.scrubVaultTranscript('answer ' + secret.slice(0,8)), 'answer [vault value]')
  api.events.broadcast({ type: 'done', sessionId: 's' }); api.events.broadcast({ type: 'done', sessionId: 'other' })
  assert.deepEqual(api.liveMessages('s'), [])
}))

test('vault unlock failure is sticky for the stream; restoring storage cannot flush its pending secret', async () => fixture(async ({ api, fake, secret, seen }) => {
  start(api); delta(api, 'before ' + secret.slice(0,8))
  api.vault.setVaultStorageForTests(null); delta(api, secret.slice(8))
  api.vault.setVaultStorageForTests(fake); delta(api, ' must remain withheld')
  api.events.broadcast({ type: 'done', sessionId: 's' })
  assert.equal(eventText(seen), 'before [Content withheld: vault unavailable or changed]')
  assert.ok(!JSON.stringify(seen).includes(secret.slice(0,8)))
}))

test('changed, missing and corrupt vault documents close an active stream without a plaintext fallback', async () => fixture(async ({ api, root, secret, seen }) => {
  const path = join(root, 'vault.json'), original = await readFile(path, 'utf8')
  for (const change of ['{broken', original + '\n', null]) {
    await writeFile(path, original); seen.length = 0; start(api); delta(api, secret.slice(0,8))
    if (change === null) await rm(path); else await writeFile(path, change)
    delta(api, secret.slice(8)); api.events.broadcast({ type: 'done', sessionId: 's' })
    assert.equal(eventText(seen), '[Content withheld: vault unavailable or changed]')
  }
}))

test('overlapping literals, mismatch recovery and original contexts are handled without retaining safe text', async () => fixture(async ({ api, secret }) => {
  await api.vault.addVaultItem({ kind: 'login', label: 'Prefix', values: { password: secret.slice(0,7) } })
  const stream = api.vault.createVaultTextStream()
  assert.deepEqual(stream.push(secret.slice(0,7), 'first'), [])
  assert.deepEqual(stream.push(secret.slice(7) + ' ok', 'second'), [{ text: '[vault value]', context: 'first' }, { text: ' ok', context: 'second' }])
  assert.deepEqual(stream.finish(), [])
  const interrupted = api.vault.createVaultTextStream()
  assert.deepEqual(interrupted.push(secret.slice(0,12), 'held'), [])
  assert.deepEqual(interrupted.finish(), [{ text: '[vault value]', context: 'held' }], 'an unfinished long match must not expose its tail after a short match')
  const mismatch = api.vault.createVaultTextStream()
  assert.deepEqual(mismatch.push('Fi', 'a'), [])
  assert.deepEqual(mismatch.push('X rest', 'b'), [{ text: 'Fi', context: 'a' }, { text: 'X rest', context: 'b' }])
}))

test('invalid adapter text mapping and unserializable tool arguments never reach public consumers raw', async () => fixture(async ({ api, secret, seen }) => {
  start(api)
  delta(api, secret, { id: 'bad', phase: 'final_answer', delta: 'different ' + secret })
  delta(api, secret)
  const args = { value: secret }; args.circular = args
  api.events.broadcast({ type: 'tool-call', sessionId: 's', messageId: 'm', call: { id: 'c', name: 'fixture', args } })
  api.events.broadcast({ type: 'done', sessionId: 's' })
  assert.ok(!JSON.stringify(seen).includes(secret)); assert.ok(eventText(seen).includes('inconsistent stream segment'))
  assert.ok(seen.some(e => e.type === 'backend-notice' && e.message.includes('could not be checked')))
}))

test('ordinary segmented speech, reasoning, usage and lifecycle retain their content and order', async () => fixture(async ({ api, seen, windows }) => {
  start(api)
  const result = await api.streamAssistantTurn({ sessionId: 's', messageId: 'm', signal: new AbortController().signal,
    stream: (async function* () {
      yield { type: 'text', delta: 'Working.', visible: true, segment: { id: 'progress', phase: 'commentary', delta: 'Working.' } }
      yield { type: 'reasoning', delta: 'Private thought.' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
      yield { type: 'text', delta: '\n\nDone 🧪', visible: true, segment: { id: 'body', phase: 'final_answer', delta: 'Done 🧪' } }
      yield { type: 'done' }
    })()
  })
  api.events.broadcast({ type: 'message-end', sessionId: 's', messageId: 'm', content: result.text, segments: result.segments })
  assert.equal(eventText(seen), 'Working.\n\nDone 🧪')
  assert.equal(eventText(seen, 'reasoning-delta'), 'Private thought.')
  assert.deepEqual(result.segments, [{ id: 'progress', phase: 'commentary', text: 'Working.' }, { id: 'body', phase: 'final_answer', text: 'Done 🧪' }])
  assert.deepEqual(seen.find(event => event.type === 'token-usage').usage, { inputTokens: 12, outputTokens: 8 })
  assert.equal(seen[0].type, 'message-start'); assert.equal(seen.at(-1).type, 'message-end')
  assert.deepEqual(windows, seen); assert.deepEqual(api.liveMessages('s'), [])
}))

test('the actual call normalizer keeps executable JSON parameters while public tool events redact a copy', async () => fixture(async ({ api, secret, seen }) => {
  start(api)
  const argumentsJson = JSON.stringify({ nested: { value: secret }, public: 'keep' })
  const result = await api.streamAssistantTurn({ sessionId: 's', messageId: 'm', signal: new AbortController().signal,
    stream: (async function* () { yield { type: 'tool_call', call: { id: 'json', name: 'virtual-tool', arguments: argumentsJson } }; yield { type: 'done' } })()
  })
  assert.deepEqual(result.calls[0].args, { nested: { value: secret }, public: 'keep' })
  assert.equal(argumentsJson, JSON.stringify(result.calls[0].args))
  const published = seen.find(event => event.type === 'tool-call')
  assert.deepEqual(published.call.args, { nested: { value: '[vault value]' }, public: 'keep' })
  assert.notEqual(published.call.args, result.calls[0].args)
  api.events.broadcast({ type: 'done', sessionId: 's' })
}))

after(async () => {
  await writeFile(join(repo, 'docs/validation/vault-stream-evidence.json'), JSON.stringify({ recordedAt: new Date().toISOString(), sharedEventSourceApplied: applied, eventSourceSha256: createHash('sha256').update(await readFile(join(repo,plan.file))).digest('hex'), originalEventSourceSha256: plan.sha256, crypto: 'virtual AES-GCM, no Electron', boundary: 'actual source, events/liveMessages/stream/call normalization/SQLite; only IPC transport stubbed and unused optional module globs empty', limits: ['exact registered literals only','separate logical channels and messages','new registrations cannot retract text published before registration','encoding/OCR/native CLI logs excluded'] }, null, 2) + '\n')
})
