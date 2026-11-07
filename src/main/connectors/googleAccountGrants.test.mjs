import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

globalThis.__googleAccountGrants = { tools: [], seen: [] }
const built = await build({ entryPoints: [fileURLToPath(new URL('../tools/agent/googleAccounts.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'account-metadata-boundaries', setup(b) {
  b.onResolve({ filter: /^\.\.\/(\.\.\/)?(apps\/status|store\/bots)$/ }, args => ({ path: args.path.includes('/apps/') ? 'status' : 'bot', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'status'
    ? 'export const googleAccountStatuses=async service=>{globalThis.__googleAccountGrants.seen.push(service);return [{id:"g_fixture",label:service+"@example.test",isDefault:true,status:"connected"}]}'
    : 'export const getBot=()=>({id:"fixture",tools:globalThis.__googleAccountGrants.tools})', loader: 'js' }))
} }] })
const { googleAccountsTool } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
async function run(tools, args = {}) { globalThis.__googleAccountGrants = { tools, seen: [] }; return googleAccountsTool.handler(args, { botId: 'fixture', sessionId: 'fixture' }) }
test('Gmail companion metadata does not reveal Calendar accounts', async () => {
  const result = await run(['search_gmail'])
  assert.equal(result.ok, true); assert.deepEqual(globalThis.__googleAccountGrants.seen, ['gmail'])
  assert.equal((await run(['gmail_draft'], { service: 'calendar' })).ok, false); assert.deepEqual(globalThis.__googleAccountGrants.seen, [])
})
test('Calendar companion metadata does not reveal Gmail accounts', async () => {
  assert.equal((await run(['calendar_event_draft'])).ok, true); assert.deepEqual(globalThis.__googleAccountGrants.seen, ['calendar'])
  assert.equal((await run(['list_calendar_events'], { service: 'gmail' })).ok, false)
})
test('explicit discovery or the union of both real service grants can list both', async () => {
  for (const tools of [['list_google_accounts'], ['read_gmail','list_calendar_events']]) { assert.equal((await run(tools)).ok, true); assert.deepEqual(globalThis.__googleAccountGrants.seen, ['gmail','calendar']) }
})
test('absent grants and invalid service never query any account metadata', async () => {
  for (const [tools, args] of [[[],{}], [['search_gmail'],{ service: 'x' }]]) { assert.equal((await run(tools,args)).ok, false); assert.deepEqual(globalThis.__googleAccountGrants.seen, []) }
})
