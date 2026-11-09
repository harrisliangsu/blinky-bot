import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const built = await build({
  stdin: { contents: "export { delegateTaskTool } from './delegate.ts'", resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'no-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = {}; export const safeStorage = {}', loader: 'js' }))
  } }]
})
const { delegateTaskTool } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`)
const context = { summary: 'Consume CSV after its producer returns', categories: ['conversion'], scope: ['src/convert'], boundaries: ['Do not modify CSV'] }
function fixture() {
  const calls = [], reads = []
  const ctx = { sessionId: 'lead', botId: 'bot', cwd: '/synthetic', signal: new AbortController().signal, requestApproval: async () => false, emit() {}, host: {
    listBots: () => { reads.push('bots'); return [{ id: 'bot', name: 'Bot' }] },
    delegateTask: (...args) => { calls.push(args); return { id: 'task', sessionId: 'execution', sourceSessionId: 'lead', title: 'Convert', plan: args[8] } }
  } }
  return { ctx, calls, reads }
}

test('observed K3.1 arguments cannot silently discard prerequisites or start work', async () => {
  const f = fixture()
  const result = await delegateTaskTool.handler({ prompt: 'Wait for CSV', depends_on: ['csv'], workspace: 'auto', workspace_reason: 'Consume retained files', plan: { context } }, f.ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /Nothing was started or continued/)
  assert.match(result.output, /inside plan: depends_on, workspace, workspace_reason/)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.reads, [], 'reject before even looking up an executor')
})

test('corrected nested plan forwards the exact dependency, workspace and context', async () => {
  const f = fixture(), plan = { depends_on: ['csv'], workspace: 'auto', context }
  const result = await delegateTaskTool.handler({ prompt: 'Wait for CSV', plan }, f.ctx)
  assert.equal(result.ok, true)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0][8], plan)
})

test('continuations reject conflicting flat planning fields; legacy plan-less callers still work', async () => {
  const f = fixture()
  const refused = await delegateTaskTool.handler({ prompt: 'Continue CSV', continue_task_id: 'csv', depends_on: ['consumer'], plan: { depends_on: [] } }, f.ctx)
  assert.equal(refused.ok, false)
  assert.deepEqual(f.calls, [])
  const legacy = await delegateTaskTool.handler({ prompt: 'Continue CSV', continue_task_id: 'csv' }, f.ctx)
  assert.equal(legacy.ok, true)
  assert.equal(f.calls[0][5], 'csv')
  assert.equal(f.calls[0][8], undefined)
})
