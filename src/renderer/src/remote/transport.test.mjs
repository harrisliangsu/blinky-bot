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
globalThis.window = new EventTarget()
globalThis.document = new EventTarget()
const access = { grant: 'synthetic-grant', permission: 'control', scope: 'workspace', sessionId: 'synthetic-session', roomId: 'synthetic-room', expiresAt: Date.now() + 60000 }
const page = { value: { id: 'synthetic-session', messages: [{ id: 'one', role: 'user', content: 'Synthetic private cache', createdAt: 1 }] }, page: { sessionId: 'synthetic-session', revision: 0, olderCursor: 'synthetic-cursor', newerCursor: null, hasMore: true, hasNewer: false } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('an explicit authentication rejection clears cached workspace even when the host closes before status confirmation', async () => {
  let rejected = false, checks = 0, lost = ''
  const identity = { signed: async path => { if (path === '/api/rpc') return page; rejected = true; throw new RemoteHttpError(401, 'Synthetic revoked grant') }, check: async () => { checks++; throw new TypeError('Synthetic host already stopped') } }
  const transport = new BrowserTransport(identity, access, () => {}, state => { lost = state })
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
  const transport = new BrowserTransport(identity, access, value => { if (value) connected = true }, () => { lost = true })
  const off = transport.api.on(() => {})
  try {
    for (let n = 0; n < 100 && !connected; n++) await wait(10)
    assert.equal(connected, true); assert.ok(requests >= 2); assert.equal(checks, 0); assert.equal(lost, false)
  } finally { off(); transport.stop() }
})
