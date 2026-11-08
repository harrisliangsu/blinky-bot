import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

// Exercise the real transport and API factory. Only desktop state loaders are
// stubbed; the test has no Electron process, account, HTTP listener or app data.
const bundled = await build({ stdin: { contents: `export { BrowserTransport } from './src/renderer/src/remote/transport'; export { RemoteHttpError } from './src/renderer/src/remote/identity'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json');` }, plugins: [{ name: 'state-only', setup(b) {
  b.onResolve({ filter: /^\.\.\/state$/ }, args => args.importer.endsWith('/remote/transport.ts') ? { path: 'state', namespace: 'fixture' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const store={optimistic:new Set(),getState:()=>({}),getMessage:()=>undefined};${['loadActivity','loadBots','loadGroups','loadProjects','loadRoutines','loadSessions','loadSettings','loadSkills','loadBackends'].map(x=>`export const ${x}=async()=>{};`).join('')}` }))
} }] })
const { BrowserTransport, RemoteHttpError } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const BaseTransport = BrowserTransport; const TestTransport = class extends BaseTransport { constructor(identity, ...args) { super({ remainingLease: grant => Math.max(0, grant.expiresAt - Date.now()), ...identity }, ...args) } }
globalThis.window = new EventTarget()
globalThis.document = new EventTarget()
const access = { grant: 'synthetic-grant', permission: 'control', scope: 'workspace', sessionId: 'synthetic-session', roomId: 'synthetic-room', expiresAt: Date.now() + 60000 }
const page = { value: { id: 'synthetic-session', messages: [{ id: 'one', role: 'user', content: 'Synthetic private cache', createdAt: 1 }] }, page: { sessionId: 'synthetic-session', revision: 0, olderCursor: 'synthetic-cursor', newerCursor: null, hasMore: true, hasNewer: false } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('an explicit authentication rejection clears cached workspace even when the host closes before status confirmation', async () => {
  let rejected = false, checks = 0, lost = ''
  const identity = { signed: async path => { if (path === '/api/rpc') return page; rejected = true; throw new RemoteHttpError(401, 'Synthetic revoked grant') }, check: async () => { checks++; throw new TypeError('Synthetic host already stopped') } }
  const transport = new TestTransport(identity, access, () => {}, state => { lost = state })
  try {
    await transport.api.sessions.get('synthetic-session')
    for (let n = 0; n < 30 && !lost; n++) await wait(10)
    assert.equal(rejected, true); assert.equal(checks, 1)
    assert.equal(lost, 'expired')
    assert.equal(transport.api.history.hasMore('synthetic-session'), false)
  } finally { transport.stop() }
})

test('ordinary Wi-Fi loss retries automatically without revoking the valid device or requiring a refresh', async () => {
  let requests = 0, checks = 0, connected = false, lost = false
  const identity = { signed: async (_path, _body, _grant, options) => {
    requests++
    if (requests === 1) throw new TypeError('Synthetic Wi-Fi interruption')
    if (requests === 2) return { revision: 0, reset: false, groups: [], sessions: [] }
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true }))
  }, check: async () => { checks++; return { access } } }
  const transport = new TestTransport(identity, access, value => { if (value) connected = true }, () => { lost = true })
  const off = transport.api.on(() => {})
  try {
    for (let n = 0; n < 100 && !connected; n++) await wait(10)
    assert.equal(connected, true); assert.ok(requests >= 2); assert.equal(checks, 1); assert.equal(lost, false)
  } finally { off(); transport.stop() }
})


test('manual retry confirms status without waiting for a quiet long poll', async () => {
  let connected = false, checks = 0
  const identity = { signed: async (_path, _body, _grant, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })), check: async () => { checks++; return { access } } }
  const transport = new TestTransport(identity, access, value => { connected = value }, () => { throw Error('must not revoke') })
  const off = transport.api.on(() => {})
  try {
    transport.reconnect()
    for (let n = 0; n < 20 && !connected; n++) await wait(5)
    assert.equal(connected, true); assert.equal(checks, 1)
  } finally { off(); transport.stop() }
})

test('manual retry cannot keep cached workspace after the host confirms revocation', async () => {
  let lost = ''
  const identity = { signed: async path => { if (path === '/api/rpc') return page; return new Promise(() => {}) }, check: async () => ({ state: 'revoked' }) }
  const transport = new TestTransport(identity, access, () => {}, state => { lost = state })
  try {
    await transport.api.sessions.get('synthetic-session')
    transport.reconnect()
    for (let n = 0; n < 20 && !lost; n++) await wait(5)
    assert.equal(lost, 'revoked'); assert.equal(transport.api.history.hasMore('synthetic-session'), false)
  } finally { transport.stop() }
})


for (const change of [{ scope: 'room' }, { permission: 'view' }]) test('changed approval clears the old workspace projection: ' + JSON.stringify(change), async () => {
  let lost = ''
  const identity = { signed: async path => path === '/api/rpc' ? page : new Promise(() => {}), check: async () => ({ state: 'approved', access: { ...access, ...change } }) }
  const transport = new TestTransport(identity, access, () => {}, state => { lost = state })
  try {
    await transport.api.sessions.get('synthetic-session'); transport.reconnect()
    for (let n = 0; n < 20 && !lost; n++) await wait(5)
    assert.equal(lost, 'changed'); assert.equal(transport.api.history.hasMore('synthetic-session'), false)
  } finally { transport.stop() }
})

test('a restarted host rotates its grant, restores watches and loaded history, and never resends a draft', async () => {
  const calls = [], states = [], restored = { ...access, grant: 'synthetic-restarted-grant' }
  let restarting = false
  const identity = { signed: async (path, body, grant, options) => {
    if (path === '/api/events') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    calls.push({ channel: body.channel, args: body.args, grant: grant.grant })
    if (body.channel === 'openbot:sessions:watch') return { value: true }
    if (body.channel === 'openbot:remote:history') return { value: { ...page.value, messages: [{ id: 'old', role: 'user', content: 'Synthetic older', createdAt: 0 }] }, page: { ...page.page, olderCursor: null, hasMore: false } }
    return restarting ? { ...page, value: { ...page.value, messages: [{ id: 'new', role: 'assistant', content: 'Synthetic reply after restart', createdAt: 3 }] } } : { ...page, value: { ...page.value, messages: [{ id: 'old', role: 'user', content: 'Synthetic older', createdAt: 0 }, ...page.value.messages] } }
  }, check: async () => ({ state: 'approved', access: restored }) }
  const transport = new TestTransport(identity, access, () => {}, state => { throw Error('unexpected loss ' + state) })
  const off = transport.api.on(event => { if (event.type === 'session-updated') states.push(event.session) })
  try {
    await transport.api.sessions.get(access.sessionId)
    await transport.api.sessions.watch('chat', access.sessionId)
    restarting = true; transport.reconnect()
    for (let n = 0; n < 50 && !states.length; n++) await wait(5)
    assert.equal(states.length, 1)
    assert.deepEqual(states[0].messages.map(message => message.id), ['old', 'new'])
    assert.ok(calls.some(call => call.channel === 'openbot:sessions:watch' && call.grant === restored.grant))
    assert.equal(calls.some(call => call.channel.includes('agent:send') || call.channel.includes('agent:enqueue')), false)
    assert.equal(transport.api.history.hasMore(access.sessionId), false)
  } finally { off(); transport.stop() }
})


test('the known approval expiry clears cached content even while the host remains offline', async () => {
  let lost = ''
  const identity = { signed: async path => path === '/api/rpc' ? page : new Promise(() => {}), check: async () => { throw new TypeError('offline') } }
  const transport = new TestTransport(identity, { ...access, expiresAt: Date.now() + 50 }, () => {}, state => { lost = state })
  try {
    await transport.api.sessions.get(access.sessionId)
    for (let n = 0; n < 30 && !lost; n++) await wait(5)
    assert.equal(lost, 'expired'); assert.equal(transport.api.history.hasMore(access.sessionId), false)
  } finally { transport.stop() }
})
