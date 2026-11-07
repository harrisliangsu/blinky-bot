/** Actual outlet checks; exact candidate support never writes shared source. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build, transform } from 'esbuild'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = process.cwd(), plan = JSON.parse(await readFile(join(repo, 'docs/validation/vault-outlet-patch-input.json'), 'utf8'))
const work = await mkdtemp(join(tmpdir(), 'blinky-vault-outlets-'))
const hashes = {}, observed = {}, applied = []
const bundle = await build({ stdin: { resolveDir: repo, contents: `
export * as vault from './src/main/store/vault';
export * as privacy from './src/main/store/vaultPrivacy';
export * as memory from './src/main/store/memory';
export * as messages from './src/main/agent/messages';
export {screenMemoryPrivacy} from './src/main/agent/memoryFilter';
export {diagnosticTail} from './src/main/backends/vaultRedaction';
export {HttpError,errorMessage} from './src/main/backends/httpErrors';
export {agentTraceEntry} from './src/main/backends/cli/agentTrace';
export {SessionDatabase} from './src/main/store/sessionDatabase';
export {flushAll} from './src/main/store/jsonStore';
` }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', plugins: [{ name: 'isolated-outlet-candidate', setup(builder) {
  builder.onResolve({ filter: /^electron$/ }, () => { throw new Error('Electron runtime is forbidden in this fixture.') })
  builder.onResolve({ filter: /^\.\/(events|sessionGateway)$/ }, (args) => args.importer === join(repo, 'src/main/agent/messages.ts') ? { path: args.path, namespace: 'outlet-stub' } : undefined)
  builder.onLoad({ filter: /.*/, namespace: 'outlet-stub' }, (args) => ({ contents: args.path === './events'
    ? 'export function broadcast(event){globalThis.__vaultEvents.push(event)}'
    : 'export const sessions={async update(session,mutate){const next=globalThis.__vaultDb.get(session.id)??structuredClone(session);mutate(next);return globalThis.__vaultDb.put(next)}}', loader: 'js' }))
  builder.onLoad({ filter: /\.ts$/ }, async (args) => {
    const key = relative(repo, args.path), original = await readFile(args.path, 'utf8')
    hashes[key] = createHash('sha256').update(original).digest('hex')
    if (!plan[key]) return undefined
    let source = original
    if (hashes[key] === plan[key].sha256) {
      for (const { before, after } of plan[key].replacements) {
        assert.equal(source.split(before).length, 2, `Ambiguous candidate anchor: ${key}`)
        source = source.replace(before, after)
      }
    } else {
      let baseline = original
      for (const { before, after } of [...plan[key].replacements].reverse()) {
        assert.equal(baseline.split(after).length, 2, `Shared source changed; re-coordinate: ${key}`)
        baseline = baseline.replace(after, before)
      }
      assert.equal(createHash('sha256').update(baseline).digest('hex'), plan[key].sha256, `Shared source changed; re-coordinate: ${key}`)
      applied.push(key)
    }
    observed[key] = hashes[key]
    return { contents: source, loader: 'ts', resolveDir: dirname(args.path) }
  })
} }] })
assert.deepEqual(Object.keys(observed).sort(), Object.keys(plan).sort())

async function fixture(run) {
  const root = await mkdtemp(join(work, 'fixture-')), path = join(root, 'module.mjs')
  await writeFile(path, bundle.outputFiles[0].text)
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const api = await import(pathToFileURL(path).href + '?fixture=' + randomUUID()), key = randomBytes(32)
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]) },
    decryptString: value => { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(12, 28)); return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString('utf8') }
  }
  api.vault.setVaultStorageForTests(fake)
  const secret = 'Fixture private value+4826/?'
  try { await run({ root, api, fake, secret, add: () => api.vault.addVaultItem({ kind: 'login', label: 'Fixture', origin: 'https://fixture.invalid', values: { password: secret } }) }) }
  finally {
    await api.flushAll(); globalThis.__vaultDb?.close(); delete globalThis.__vaultDb; delete globalThis.__vaultEvents
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('fresh redaction sees replacement ciphertext and works inside the fill lock', async () => fixture(async ({ root, api, fake, secret, add }) => {
  const item = await add()
  assert.equal(await api.vault.useVaultField(item.id, 'password', async () => api.vault.scrubVaultTextNow(secret).redacted), true)
  const file = join(root, 'vault.json'), doc = JSON.parse(await readFile(file, 'utf8')), changed = secret + ' changed'
  doc.items[0].ciphertext = fake.encryptString(JSON.stringify({ password: changed })).toString('base64')
  await writeFile(file, JSON.stringify(doc))
  assert.equal((await api.vault.scrubVaultText(changed)).redacted, true)
  assert.ok(!(await api.vault.scrubVaultText(changed)).text.includes(changed))
}))

test('memory writers reject literals before replacing prior memory', async () => fixture(async ({ root, api, secret, add }) => {
  await add(); await api.memory.loadMemory()
  const safe = '用户习惯先阅读完整方案再开始执行任务。', unsafe = `用户习惯使用 ${secret} 标记自己的长期项目。`
  assert.equal(api.screenMemoryPrivacy(unsafe).ok, true, 'fixture must reach the vault-specific gate')
  const original = await api.memory.writeUserMemory('fixture-bot', safe)
  await assert.rejects(api.memory.writeUserMemory('fixture-bot', unsafe, original.id), /保险库/)
  assert.equal(api.memory.listBotMemory('fixture-bot')[0].id, original.id)
  assert.throws(() => api.memory.addBotMemory('fixture-bot', unsafe), /保险库/)
  await assert.rejects(api.memory.addBotMemoryDurable('fixture-bot', unsafe), /保险库/)
  await assert.rejects(api.memory.addUserPreference(unsafe), /保险库/)
  await api.flushAll()
  assert.ok(!(await readFile(join(root, 'memory/fixture-bot.json'), 'utf8')).includes(secret))
}))

test('memory reads hide pre-existing vault literals without deleting disk data', async () => fixture(async ({ root, api, secret, add }) => {
  await api.memory.loadMemory()
  const sentence = `用户习惯使用 ${secret} 标记自己的长期项目。`
  const old = await api.memory.writeUserMemory('fixture-bot', sentence, undefined, 'old-request')
  await api.memory.addUserPreference(sentence, 'old-preference')
  assert.ok(old)
  await add()
  assert.equal(api.memory.listBotMemory('fixture-bot').length, 0)
  await assert.rejects(api.memory.writeUserMemory('fixture-bot', '用户习惯先阅读完整方案再开始执行任务。', undefined, 'old-request'), /保险库/)
  await assert.rejects(api.memory.addUserPreference('用户习惯先阅读完整方案再开始执行任务。', 'old-preference'), /保险库/)
  assert.ok((await readFile(join(root, 'memory/fixture-bot.json'), 'utf8')).includes(secret), 'historical data was not silently rewritten')
}))

test('diagnostics and native trace redact values without returning raw errors', async () => fixture(async ({ api, secret, add }) => {
  await add()
  assert.ok(!api.diagnosticTail('CLI output ' + secret).includes(secret))
  assert.ok(!new api.HttpError(400, secret, 'https://fixture.invalid').message.includes(secret))
  const pathValue = 'FixtureUrlValue4826'
  await api.vault.addVaultItem({ kind: 'login', label: 'Virtual route fixture', values: { password: pathValue } })
  const error = new api.HttpError(400, 'fixture body', 'https://fixture.invalid/' + pathValue)
  assert.ok(!error.message.includes(pathValue)); assert.ok(!error.url.includes(pathValue))
  assert.ok(!api.errorMessage(new Error(secret)).includes(secret))
  assert.ok(!JSON.stringify(api.agentTraceEntry('call', 'read_file', 'completed', { output: secret, nested: [secret] })).includes(secret))
  api.vault.setVaultStorageForTests(null)
  assert.ok(api.diagnosticTail(secret).includes('withheld'))
  assert.ok(!JSON.stringify(api.agentTraceEntry('call', 'read_file', 'completed', { output: secret })).includes(secret))
}))

test('transcript writes use a safe copy and preserve executable args and image bytes', async () => fixture(async ({ root, api, secret, add }) => {
  await add()
  const db = globalThis.__vaultDb = new api.SessionDatabase(join(root, 'sessions.sqlite'))
  globalThis.__vaultEvents = []
  const session = { id: 'fixture-session', title: 'Fixture', cwd: root, botIds: ['fixture-bot'], activeBotId: 'fixture-bot', messages: [], createdAt: 1, updatedAt: 1 }
  db.put(session)
  const call = { id: 'call-1', name: 'type_text', args: { text: secret } }, before = JSON.stringify(call)
  const message = { id: 'message-1', role: 'assistant', content: secret, displayContent: secret, reasoning: secret, createdAt: 1, toolCalls: [call], segments: [{ id: 'segment', phase: 'final_answer', text: secret }], toolResult: { callId: 'call-1', name: 'fixture', ok: true, output: secret, detail: { nested: [secret] }, screenshot: 'fixture-image-bytes' } }
  api.messages.begin(session.id, message); await api.messages.commit(session, message)
  await api.messages.addToolMessage(session, 'fixture-bot', { callId: 'call-2', name: 'fixture', ok: true, output: secret })
  assert.ok(!JSON.stringify(db.get(session.id)).includes(secret))
  assert.ok(!JSON.stringify(globalThis.__vaultEvents).includes(secret))
  assert.equal(JSON.stringify(call), before, 'recording never rewrites executable tool arguments')
  const saved = db.get(session.id).messages[0]
  assert.equal(db.getBlob(saved.toolResult.screenshotRef), 'fixture-image-bytes')
}))

test('unavailable vault blocks memory and stores placeholders instead of plaintext', async () => fixture(async ({ root, api, secret, add }) => {
  await add(); await api.memory.loadMemory(); api.vault.setVaultStorageForTests(null)
  await assert.rejects(api.memory.writeUserMemory('fixture-bot', '用户习惯先阅读完整方案再开始执行任务。'), /保险库/)
  const safe = api.privacy.scrubVaultMessage({ id: 'message', role: 'tool', content: secret, createdAt: 1, toolCalls: [{ id: 'call', name: 'fixture', args: { text: secret } }] })
  assert.ok(!JSON.stringify(safe).includes(secret)); assert.equal(safe.toolCalls[0].id, 'call')
  assert.ok(safe.content.includes('withheld'))
  await writeFile(join(root, 'vault.json'), '{broken')
  assert.equal(api.vault.scrubVaultTextNow(secret).unavailable, true)
  assert.ok(!api.diagnosticTail(secret).includes(secret))
}))

test('numeric private values are masked while routing ids and public flags remain intact', async () => fixture(async ({ api }) => {
  const number = '4242424242424242'
  await api.vault.addVaultItem({ kind: 'card', label: 'Virtual fixture card', values: { number } })
  const safe = api.privacy.scrubVaultMessage({ id: 'stable-message', role: 'tool', content: '', createdAt: 1, toolResult: { callId: 'stable-call', name: 'fixture', ok: true, output: '', detail: { number: Number(number), count: 3, unbounded: Infinity } } })
  assert.ok(!JSON.stringify(safe).includes(number)); assert.equal(safe.toolResult.ok, true)
  assert.equal(safe.toolResult.callId, 'stable-call'); assert.equal(safe.toolResult.detail.count, 3)
  assert.ok(!api.agentTraceEntry('stable-call', 'fixture', 'completed', { number: Number(number) }).detail.includes(number))
}))

test('literal matching explicitly does not cover encoded values or split stream chunks', async () => fixture(async ({ api, secret, add }) => {
  await add()
  assert.equal(api.vault.scrubVaultTextNow(encodeURIComponent(secret)).redacted, false)
  assert.equal(api.vault.scrubVaultTextNow(secret.slice(0, 9)).redacted, false)
  assert.equal(api.vault.scrubVaultTextNow(secret.slice(9)).redacted, false)
  assert.equal(api.vault.scrubVaultTextNow(secret).redacted, true)
}))

test('renderer task presentation bundles without importing main-process storage', async () => {
  const browser = await build({ entryPoints: [join(repo, 'src/renderer/src/components/agentTaskPresentation.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  assert.ok(!Object.keys(browser.metafile.inputs).some(file => /store\/vault|vaultRedaction|node:fs|store\/paths/.test(file)))
})

test('actual executor checkpoint projects private text before SQLite and keeps original calls', async () => fixture(async ({ root, api, secret, add }) => {
  await add()
  const source = await readFile(join(repo, 'src/main/agent/turn.ts'), 'utf8')
  const start = source.indexOf('onCheckpoint: async (partial:'), end = source.indexOf('\n      } } : {})', start)
  assert.ok(start >= 0 && end > start)
  const arrow = source.slice(start + 'onCheckpoint: '.length, end) + '\n}'
  const { code } = await transform('const checkpoint = ' + arrow, { loader: 'ts', format: 'cjs' })
  const db = globalThis.__vaultDb = new api.SessionDatabase(join(root, 'sessions.sqlite'))
  const message = { id: 'checkpoint', role: 'assistant', content: '', streaming: true, createdAt: 1 }
  const session = { id: 'checkpoint-session', title: 'Fixture', cwd: root, botIds: ['fixture-bot'], activeBotId: 'fixture-bot', messages: [message], createdAt: 1, updatedAt: 1 }
  db.put(session)
  let flushed = false
  const sessions = { async update(input, mutate) { const next = db.get(input.id); mutate(next); return db.put(next) } }
  const checkpoint = new Function('sessions', 'session', 'message', 'scrubVaultMessage', 'flushAll', code + '; return checkpoint')(sessions, session, message, api.privacy.scrubVaultMessage, async () => { flushed = true; return { failed: [], stillWriting: false } })
  const call = { id: 'call', name: 'fixture', args: { text: secret } }
  await checkpoint({ text: secret, reasoning: secret, calls: [call], agentTrace: [] })
  assert.ok(flushed); assert.ok(!JSON.stringify(db.get(session.id)).includes(secret)); assert.equal(call.args.text, secret)
}))

after(async () => {
  const changed = []
  for (const [file, sha] of Object.entries(hashes)) if (createHash('sha256').update(await readFile(resolve(repo, file))).digest('hex') !== sha) changed.push(file)
  await writeFile(join(repo, 'docs/validation/vault-outlet-candidate-evidence.json'), JSON.stringify({ candidateOnly: applied.length !== Object.keys(plan).length, sharedSourceApplied: applied.length === Object.keys(plan).length, appliedSharedFiles: applied, pendingSharedFiles: Object.keys(plan).filter(file => !applied.includes(file)), virtualCredentials: true, electronStarted: false, patchedSharedSourceHashes: observed, changedDuringTest: changed }, null, 2) + '\n')
  await rm(work, { recursive: true, force: true })
})
