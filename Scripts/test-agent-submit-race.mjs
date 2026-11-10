// Exercise the actual registered IPC handlers. All host services are private
// fixtures; this test imports no Electron, provider, user data or credentials.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = path.resolve(import.meta.dirname, '..')
const target = path.join(repo, 'src/main/ipc/agent.ts')
const source = await readFile(target, 'utf8')
const exportsByPath = new Map()
for (const [, names, specifier] of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
  exportsByPath.set(specifier, [...new Set([...(exportsByPath.get(specifier) ?? []), ...names.split(',').map(name => name.trim()).filter(name => name && !name.startsWith('type '))])])
}
const root = await mkdtemp(path.join(tmpdir(), 'blinky-submit-race-'))
try {
  const output = path.join(root, 'agent.mjs')
  await build({ entryPoints: [target], outfile: output, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'private-host', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return
      if (args.path === './startTurn') return { path: path.join(repo, 'src/main/ipc/startTurn.ts') }
      assert.ok(exportsByPath.has(args.path), 'Unexpected service import: ' + args.path)
      return { path: args.path, namespace: 'private-host' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'private-host' }, args => ({ contents: exportsByPath.get(args.path).map(name => {
      if (name === 'CHANNELS') return 'export const CHANNELS=globalThis.__submitFixture.channels'
      if (name === 'AGENT_UNAVAILABLE') return 'export const AGENT_UNAVAILABLE="unavailable"'
      if (name === 'sessions') return 'export const sessions={get:(...args)=>globalThis.__submitFixture.api.sessions.get(...args)}'
      return `export const ${name}=(...args)=>globalThis.__submitFixture.api.${name}(...args)`
    }).join('\n'), loader: 'js' }))
  } }] })
  const channels = new Proxy({}, { get: (_, key) => 'fixture:' + String(key) })
  globalThis.__submitFixture = { channels }
  const { registerAgentIpc } = await import(pathToFileURL(output))
  function fixture() {
    const f = { channels, ui: new Map(), native: new Map(), queued: [], messages: [], events: [], starting: false, running: false, draining: false, pendingWrite: false, cancelled: false, suspended: false, started: 0, unpaused: 0 }
    const api = {
      getSession: () => ({ id: 'home', botIds: ['bot'], mode: 'agent' }),
      handle: (channel, callback) => { f.native.set(channel, callback); f.ui.set(channel, (_event, args) => callback(args)) },
      handleEvent: (channel, callback) => f.ui.set(channel, callback),
      handleVoid: () => {}, registerNativeHandler: (channel, callback) => f.native.set(channel, callback),
      asId: value => value, asString: value => value, asAttachments: value => value ?? [],
      broadcast: event => f.events.push(event), traceChatTiming: () => {},
      isRunning: () => f.running, isStarting: () => f.starting,
      isQueueDraining: () => f.draining, hasPendingQueueWrite: () => f.pendingWrite,
      isQueueSuspended: () => f.suspended,
      getMessageQueue: () => ({ sessionId: 'home', paused: f.suspended, items: f.queued }),
      beginQueueWrite: () => { f.pendingWrite = true }, endQueueWrite: () => { f.pendingWrite = false },
      enqueueMessage: async (_id, body, files, paused) => { if (f.failWrite) throw Error('fixture durable queue failure'); f.queued.push({ id: 'queued-' + f.queued.length, text: body, attachments: files, createdAt: 1 }); return { sessionId: 'home', paused, items: f.queued } },
      sessions: undefined,
      addUserMessage: async (_session, body, _files, _internal, id) => f.messages.push({ id, body }),
      captureUserPreference: async () => {}, announceQueue: () => {}, drainQueue: async () => {},
      reserveStart: () => { f.starting = true; f.cancelled = false },
      releaseStart: () => { f.starting = false }, isStartCancelled: () => f.cancelled,
      unsuspendQueue: () => { f.unpaused++; f.suspended = false },
      suspendQueue: () => { f.suspended = true }, pauseQueueIfNeeded: async () => {},
      consumeGmailUserIntent: async () => ({ consumed: false, accepted: false }),
      loopFn: async () => { await f.duringLookup?.(); return () => { f.started++ } }
    }
    Object.defineProperty(api, 'sessions', { value: { get: async () => ({ id: 'home' }) } })
    // Object-valued service imports are emitted separately from functions.
    globalThis.__submitFixture = { channels, api }
    registerAgentIpc()
    f.send = (native = false) => native ? f.native.get(channels.agentSend)(['home', 'new user request', []]) : f.ui.get(channels.agentSend)({ sender: { id: 1 } }, ['home', 'new user request', []])
    return f
  }
  for (const busy of ['running', 'starting', 'draining', 'pendingWrite', 'existingQueue']) test(`trusted renderer accepts a new request during ${busy} without pretending execution completed`, async () => {
    const f = fixture()
    if (busy === 'existingQueue') f.queued.push({ id: 'earlier' }); else f[busy] = true
    assert.equal(await f.send(), true)
    assert.equal(f.started, 0)
    assert.equal(f.messages.at(-1)?.body, 'new user request')
    assert.equal(f.queued.at(-1)?.text, 'new user request')
    assert.equal(f.events.some(event => event.type === 'done'), false)
  })
  test('native send preserves its busy rejection contract', async () => {
    const f = fixture(); f.running = true
    assert.equal(await f.send(true), false); assert.equal(f.queued.length, 0)
  })
  test('busy trusted submission preserves a stopped queue', async () => {
    const f = fixture(); f.running = true; f.suspended = true
    assert.equal(await f.send(), true); assert.equal(f.suspended, true); assert.equal(f.unpaused, 0)
  })
  test('stop during runtime lookup rejects rather than reviving or queuing the request', async () => {
    const f = fixture(); f.duringLookup = async () => { f.cancelled = true; f.running = true; f.suspended = true }
    assert.equal(await f.send(), false); assert.equal(f.started, 0); assert.equal(f.queued.length, 0); assert.equal(f.unpaused, 0)
  })
  test('a real run racing runtime lookup falls back to one durable queued request', async () => {
    const f = fixture(); f.duringLookup = async () => { f.running = true }
    assert.equal(await f.send(), true); assert.equal(f.started, 0); assert.equal(f.messages.length, 1)
  })
  test('idle submission starts once; a failed queue write is not acknowledged', async () => {
    const f = fixture(); assert.equal(await f.send(), true); assert.equal(f.started, 1)
    const failed = fixture(); failed.running = true; failed.failWrite = true
    await assert.rejects(failed.send(), /durable queue failure/); assert.equal(failed.messages.length, 0)
  })
} finally {
  // node:test callbacks run after module evaluation, so retain the imported
  // in-memory module and remove only its private build files.
  await rm(root, { recursive: true, force: true })
}
