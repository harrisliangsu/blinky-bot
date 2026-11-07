// Pure Node DOM regression for the real Bot editor/hook; no Electron, IPC or network.
// Reuse the isolated DOM dependency used by test-agent-session-dom.mjs.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const { Window } = await import(pathToFileURL(process.env.BLINKY_DOM_MODULE ?? './node_modules/happy-dom/lib/index.js').href)
const window = new Window({ url: 'https://isolated.invalid', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableFileSystemHttpRequests: false } })
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : key === 'document' ? window.document : window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = window.fetch = () => { throw new Error('Unexpected network access') }
// Browser dependencies can create native Node ports. Own and close those ports
// at teardown so the DOM fixture cannot leave the test process running.
const NativeMessageChannel = globalThis.MessageChannel
const channels = []
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() { super(); channels.push(this) }
}
const temp = await mkdtemp(resolve(tmpdir(), 'blinky-executor-config-dom-'))
after(async () => {
  window.happyDOM.abort(); window.happyDOM.close()
  for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  globalThis.MessageChannel = NativeMessageChannel
  await rm(temp, { recursive: true, force: true })
})
const rootDir = resolve(import.meta.dirname, '..')
const bundle = await build({
  stdin: { contents: `import React from 'react'; export {createRoot} from 'react-dom/client'; export const act = React.act; export const createElement = React.createElement; export {BotEditor} from './src/renderer/src/components/BotEditor'; export {store} from './src/renderer/src/state/core';`, resolveDir: rootDir, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'unrelated-panels', setup(b) {
    // Avatar artwork uses Vite's import.meta.glob; model/hook regressions do
    // not need image decoding. The real Electron acceptance covers artwork.
    b.onResolve({ filter: /^\.\/(BotMemory|BotSkills|BotTargetFields|BotAvatar)$/ }, a => ({ path: a.path.slice(2), namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: `export const ${a.path}=()=>null`, loader: 'js' }))
  } }]
})
const path = resolve(temp, 'editor.mjs')
await writeFile(path, bundle.outputFiles[0].text)
const { BotEditor, store, createRoot, act, createElement } = await import(pathToFileURL(path).href)
const settings = { language: 'en', defaultBackendId: 'codex', defaultModelId: 'lead-model', defaultThinking: 'low', backends: { openai: { added: true } } }
const backends = [
  { id: 'codex', label: 'Codex', kind: 'agent-cli', status: 'available', models: [{ id: 'lead-model', label: 'Lead', supportedThinking: ['low', 'high'] }] },
  { id: 'kimi', label: 'Kimi', kind: 'agent-cli', status: 'available', models: [{ id: 'worker-model', label: 'Worker', supportedThinking: ['low', 'high', 'max'] }] },
  { id: 'openai', label: 'OpenAI', kind: 'api-key', status: 'available', models: [{ id: 'gpt-5', label: 'Provider model' }] }
]
const original = { id: 'lead', name: 'Lead', description: 'Keep description', systemPrompt: 'Keep instructions', emoji: 'B', color: '#7c9cff', backendId: 'codex', modelId: 'lead-model', thinking: 'low', followsDefault: false, tools: ['read_file', 'delegate_task'], skills: ['local:skill'], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 2 }
let host, root, writes, saved
async function mount(bot, template) {
  writes = []; saved = []
  window.openbot = { bots: {
    update: async (id, patch) => { writes.push(patch); return { ok: true, bot: { ...bot, ...patch, id } } },
    create: async patch => { writes.push(patch); return { ok: true, bot: { ...patch, id: 'created', createdAt: 1, updatedAt: 1 } } },
    cancelProvision: async () => {}
  } }
  store.patch({ settings, bots: bot ? [bot] : [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(createElement(BotEditor, { bot, template, backends, backendsLoading: false, backendsError: null, onClose() {}, onSaved: bot => saved.push(bot), embedded: true })))
}
async function unmount() { await act(async () => root.unmount()); host.remove() }
const section = label => document.querySelector(`section[aria-label="${label}"]`)
const controls = label => [...section(label).querySelectorAll('select')]
async function select(control, value) { await act(async () => { control.value = value; control.dispatchEvent(new window.Event('change', { bubbles: true })) }) }
async function save() { const button = document.querySelector('.ob-bot-editor-save .ob-btn-primary'); assert.equal(button.disabled, false); await act(async () => button.click()); assert.equal(writes.length, 1); assert.equal(saved.length, 1); return writes[0] }

test('old disabled Bot has both model editors and saves without the retired flag', async () => {
  await mount({ ...original, executionAgentDisabled: true })
  try {
    assert.equal(section('Execution agent').querySelector('input[type=checkbox]'), null)
    assert.doesNotMatch(document.body.textContent, /Enable independent execution agent|启用独立执行 Agent/)
    assert.deepEqual(controls('Execution agent').map(e => e.value), ['codex', 'lead-model', 'low'])
    await select(controls('Conversation model')[0], 'kimi')
    await select(controls('Conversation model')[1], 'worker-model')
    await select(controls('Conversation model')[2], 'high')
    assert.deepEqual(controls('Execution agent').map(e => e.value), ['codex', 'lead-model', 'low'])
    const patch = await save()
    assert.equal(Object.hasOwn(patch, 'emoji'), false)
    assert.equal(saved[0].emoji, original.emoji)
    assert.equal(Object.hasOwn(patch, 'executionAgentDisabled'), false)
    assert.deepEqual(patch.executionAgent, { backendId: 'codex', modelId: 'lead-model', thinking: 'low' })
    assert.deepEqual([patch.backendId, patch.modelId, patch.thinking], ['kimi', 'worker-model', 'high'])
    assert.equal(Object.hasOwn(patch, 'tools'), false)
    assert.equal(Object.hasOwn(patch, 'skills'), false)
    assert.deepEqual(saved[0].tools, original.tools)
    assert.deepEqual(saved[0].skills, original.skills)
  } finally { await unmount() }
})

test('Agent provider, model and thinking can change without changing the conversation', async () => {
  await mount({ ...original, executionAgentDisabled: true, executionAgent: { backendId: 'kimi', modelId: 'worker-model', thinking: 'high' } })
  try {
    assert.deepEqual(controls('Execution agent').map(e => e.value), ['kimi', 'worker-model', 'high'])
    await select(controls('Execution agent')[0], 'openai')
    await select(controls('Execution agent')[1], 'gpt-5')
    await select(controls('Execution agent')[2], 'high')
    const patch = await save()
    assert.deepEqual(patch.executionAgent, { backendId: 'openai', modelId: 'gpt-5', thinking: 'high' })
    assert.deepEqual([patch.backendId, patch.modelId, patch.thinking], ['codex', 'lead-model', 'low'])
  } finally { await unmount() }
})

test('new template Bots get an independently pinned Agent and delegation tool without a switch', async () => {
  await mount(null, { id: 'test', name: 'Template Bot', description: '', systemPrompt: 'Template', emoji: 'T', color: '#7c9cff', tools: ['read_file'] })
  try {
    await select(controls('Conversation model')[0], 'kimi')
    const patch = await save()
    assert.deepEqual(patch.executionAgent, { backendId: 'codex', modelId: 'lead-model', thinking: 'low' })
    assert.deepEqual(patch.tools, ['read_file', 'delegate_task'])
    assert.equal(Object.hasOwn(patch, 'executionAgentDisabled'), false)
  } finally { await unmount() }
})

test('a saved Bot without a delegation grant keeps its tools and can still configure an Agent', async () => {
  await mount({ ...original, tools: ['read_file'] })
  try {
    assert.equal(controls('Execution agent').length, 3)
    const patch = await save()
    assert.equal(Object.hasOwn(patch, 'tools'), false)
    assert.deepEqual(saved[0].tools, ['read_file'])
    assert.deepEqual(patch.executionAgent, { backendId: 'codex', modelId: 'lead-model', thinking: 'low' })
  } finally { await unmount() }
})

test('hidden legacy VM target and permissions are preserved without a new probe', async () => {
  const computerTarget = { kind: 'vm', vmId: 'offline', endpoint: 'http://127.0.0.1:9' }
  await mount({ ...original, computerTarget, computerUse: true })
  try {
    window.openbot.bots.probeTarget = () => { throw new Error('An unchanged hidden target must not be probed') }
    const patch = await save()
    for (const field of ['computerTarget', 'computerUse', 'tools', 'skills']) assert.equal(Object.hasOwn(patch, field), false)
    assert.deepEqual(saved[0].computerTarget, computerTarget)
    assert.equal(saved[0].computerUse, true)
    assert.deepEqual(saved[0].tools, original.tools)
  } finally { await unmount() }
})
