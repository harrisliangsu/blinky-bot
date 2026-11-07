import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Bundle the real in-app executor and call dispatcher with small boundary
// doubles: no Electron process, network, files or approval UI are touched.
const mocks = {
  './toolGateway': `export async function getTool(name) { return globalThis.__grantFixture.tools[name] ?? null }
    export async function schemasFor(enabled, target) { return globalThis.__grantFixture.schemas(enabled, target) }`,
  './approval': `export async function requestApproval() { return { approved: true } }`,
  './approvalPolicy': `export const deniedRuleForCall = () => null; export const denyRefusal = () => ''; export const detailFor = () => ''; export const kindForTool = () => 'write'; export const summarise = () => ''; export const targetForCall = () => ''`,
  './builtinHandlers': `export const applyTodos = async () => {}; export const normaliseTodos = () => []; export const runRemember = async () => ({ok:true,output:'remembered'}); export const runTodoWrite = async () => ({ok:true,output:'todo'})`,
  './events': `export const broadcast = () => {}`,
  './errors': `export const errorMessage = (e) => String(e); export const isAbortError = () => false`,
  './recorder': `export const captureToolStep = () => {}; export const noteFrame = () => {}`,
  './toolContext': `export const SELF_APPROVING = new Set(); export const buildToolContext = () => ({})`,
  './ids': `export const now = () => Date.now()`,
  '../vm/appleVmSupervisor': `export const startAppleVm = async () => {}`,
  '../store/vmSecrets': `export const vmToken = () => ''`,
  './messages': `export const addToolMessage = async (_s, _b, result) => { globalThis.__grantFixture.results.push(result) }`,
  './handoff': `export const performHandoff = async () => { globalThis.__grantFixture.handoffs++; return {ok:true,toBotId:'other',reason:'test'} }; export const takePendingNote = () => undefined`,
  './sessionGateway': `export const sessions = { update: async (session, callback) => callback({ ...session, messages: session.messages ?? [] }) }`
}
const bundle = await build({
  stdin: { contents: `export { runCalls } from './calls.ts'; export { executeCall } from './execute.ts'`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  }}]
})
const { runCalls, executeCall } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

const schema = (name, extra = {}) => ({ name, mutating: false, parameters: { type: 'object', properties: {} }, ...extra })
function setup(enabled, { target } = {}) {
  const fixture = { results: [], calls: [], handoffs: 0, tools: {},
    schemas: (ids, computerTarget) => ids.filter((id) => !(computerTarget?.kind === 'vm' && id === 'search_gmail')).map((id) => schema(id)).concat(ids.includes('delegate_task') ? [schema('review_task')] : []) }
  for (const name of ['search_gmail', 'read_file', 'click', 'double_click', 'review_task', 'handoff']) {
    fixture.tools[name] = { schema: schema(name, name === 'click' || name === 'double_click' ? { computerUse: true } : {}), handler: async () => { fixture.calls.push(name); return { ok: true, output: 'ran' } } }
  }
  globalThis.__grantFixture = fixture
  const bot = { id: 'b', tools: enabled, computerUse: true, computerTarget: target }
  const input = { session: { id: 's', mode: 'agent' }, bot, settings: {}, signal: new AbortController().signal }
  return { fixture, input }
}
async function invoke(input, name) {
  return runCalls(input, { id: 'm', toolCalls: [{ id: 'c', name, args: {} }] }, '', 'agent')
}

test('unadvertised account read is refused before the handler, explicit grant succeeds', async () => {
  let { fixture, input } = setup(['delegate_task'])
  await invoke(input, 'search_gmail')
  assert.deepEqual(fixture.calls, [])
  assert.match(fixture.results[0].output, /not enabled/)
  ;({ fixture, input } = setup(['search_gmail']))
  await invoke(input, 'search_gmail')
  assert.deepEqual(fixture.calls, ['search_gmail'])
  assert.equal(fixture.results[0].ok, true)
})

test('aliases follow their canonical grant, including VM restrictions and review dependency', async () => {
  let { fixture, input } = setup([])
  await invoke(input, 'double_click')
  assert.deepEqual(fixture.calls, [])
  ;({ fixture, input } = setup(['click', 'delegate_task']))
  await invoke(input, 'double_click')
  await invoke(input, 'review_task')
  assert.deepEqual(fixture.calls, ['double_click', 'review_task'])
  ;({ fixture, input } = setup(['search_gmail'], { target: { kind: 'vm' } }))
  await invoke(input, 'search_gmail')
  assert.deepEqual(fixture.calls, [])
  assert.equal(fixture.results[0].ok, false)
})

test('handoff special branch requires its own grant', async () => {
  let { fixture, input } = setup([])
  assert.equal((await invoke(input, 'handoff')).status, 'tools')
  assert.equal(fixture.handoffs, 0)
  assert.match(fixture.results[0].output, /not enabled/)
  ;({ fixture, input } = setup(['handoff']))
  assert.equal((await invoke(input, 'handoff')).status, 'handoff')
  assert.equal(fixture.handoffs, 1)
})

test('recorded routine replay cannot bypass the grant', async () => {
  const { fixture, input } = setup([])
  const result = await executeCall({ ...input, call: { id: 'c', name: 'search_gmail', args: {} }, messageId: 'm', record: false })
  assert.equal(result.ok, false)
  assert.match(result.output, /not enabled/)
  assert.deepEqual(fixture.calls, [])
})

test('enabled loop-owned builtins remain usable without the optional registry', async () => {
  const { fixture, input } = setup(['todo_write'])
  fixture.schemas = () => []
  await invoke(input, 'todo_write')
  assert.equal(fixture.results[0].ok, true)
  assert.equal(fixture.results[0].output, 'todo')
})
