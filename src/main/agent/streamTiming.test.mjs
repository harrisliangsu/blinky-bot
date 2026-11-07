import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

// Real stream consumer; replace only the Electron fan-out and tool dispatcher.
const bundle = await build({
  entryPoints: ['src/main/agent/stream.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'timing-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\/(events|backendGateway)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === './events'
      ? 'export const broadcast=()=>{};export const onAgentEvent=()=>()=>{};'
      : 'export const normaliseCall=x=>x;' }))
  } }]
})
const { streamAssistantTurn } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('first-body timing excludes private reasoning, unknown text, whitespace and public commentary', async () => {
  const stages = []
  async function* stream() {
    yield { type: 'reasoning', delta: 'PRIVATE' }
    yield { type: 'text', delta: 'unclassified' }
    yield { type: 'text', delta: ' \n', visible: true }
    assert.deepEqual(stages, [])
    yield { type: 'text', delta: 'Public progress', segment: { id: 'p', phase: 'commentary', delta: 'Public progress' } }
    assert.deepEqual(stages, ['first-public-text'])
    yield { type: 'text', delta: 'BODY', visible: true }
    assert.deepEqual(stages, ['first-public-text', 'first-body-text'])
    yield { type: 'text', delta: 'more', visible: true }
    yield { type: 'done' }
  }
  const result = await streamAssistantTurn({ sessionId: 'timing-test', messageId: 'answer', signal: new AbortController().signal, stream: stream(), onTiming: stage => { stages.push(stage) } })
  assert.equal(result.error, undefined)
  assert.deepEqual(stages, ['first-public-text', 'first-body-text'])
})
