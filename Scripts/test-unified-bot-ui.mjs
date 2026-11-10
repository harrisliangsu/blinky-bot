// Interaction regression only. Avatar drawing and external resource panels are
// isolated here; mounted Electron remains the visual/layout acceptance gate.
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const { Window } = await import(pathToFileURL(process.env.BLINKY_DOM_MODULE ?? './node_modules/happy-dom/lib/index.js').href)
const window = new Window({ url: 'https://isolated.invalid', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableFileSystemHttpRequests: false } })
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : key === 'document' ? window.document : window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = window.fetch = () => { throw new Error('Unexpected network access') }
const NativeMessageChannel = globalThis.MessageChannel, channels = []
globalThis.MessageChannel = class extends NativeMessageChannel { constructor() { super(); channels.push(this) } }
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-unified-bot-ui-'))
after(async () => {
  window.happyDOM.abort(); window.happyDOM.close()
  for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  globalThis.MessageChannel = NativeMessageChannel
  await fs.rm(temp, { recursive: true, force: true })
})
const repo = path.resolve(import.meta.dirname, '..')
const bundle = await build({
  stdin: { contents: `import React from 'react'; export {createRoot} from 'react-dom/client'; export const act=React.act, createElement=React.createElement; export {BotEditor} from './src/renderer/src/components/BotEditor'; export {useShortcuts} from './src/renderer/src/lib/useShortcuts'; export {store} from './src/renderer/src/state/core';`, resolveDir: repo, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'isolated-external-panels', setup(b) {
    b.onResolve({ filter: /^\.\/(BotMemory|BotResourceLinks|BotAvatar)$/ }, a => ({ path: a.path.slice(2), namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: `import React from 'react'; export const ${a.path}=()=>null`, loader: 'tsx', resolveDir: repo }))
  } }]
})
const entry = path.join(temp, 'ui.mjs'); await fs.writeFile(entry, bundle.outputFiles[0].text)
const { BotEditor, store, useShortcuts, createElement: h, createRoot, act } = await import(pathToFileURL(entry).href)
const settings = { language: 'en', defaultBackendId: 'codex', defaultModelId: 'test-model', backends: {} }
const backends = [{ id: 'codex', label: 'Codex', kind: 'agent-cli', status: 'available', models: [{ id: 'test-model', label: 'Test Model', supportedThinking: ['low', 'high'] }] }]
const bot = { id: 'legacy-bot', name: 'Legacy', emoji: '🧪', color: '#123456', description: '', systemPrompt: '', backendId: 'codex', modelId: 'test-model', followsDefault: false, tools: [], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 }
let root, host, writes, closes, removed, deleteResult
async function mount() {
  writes=[]; closes=0; removed=[]; deleteResult={ok:false,error:'Synthetic removal failure'}
  window.openbot = { bots: {
    update: async (id, patch) => { writes.push(patch); return {ok:true,bot:{...bot,...patch}} },
    remove: async id => { removed.push(id); return deleteResult }, cancelProvision: async () => ({ active: false })
  } }
  store.patch({ settings, bots: [bot], modal: null, streaming: false, approvals: [] })
  host=document.createElement('div'); document.body.append(host); root=createRoot(host)
  await act(async()=>root.render(h(BotEditor,{ bot, backends, backendsLoading:false, backendsError:null, embedded:true, onClose(){closes++}, onSaved(){} })))
}
async function unmount(){await act(async()=>root.unmount());host.remove()}
const button = text => [...document.querySelectorAll('button')].find(e=>e.textContent.trim()===text)

test('legacy appearance stays intact and custom emoji editing is retired', async()=>{
  await mount()
  try {
    assert.equal(document.querySelector('#ob-bot-emoji'),null)
    assert.equal(document.querySelector('.ob-bot-emoji-row'),null)
    assert.match(document.body.textContent,/Original avatar retained/)
    await act(async()=>button('Save changes').click())
    assert.equal(writes[0].emoji,bot.emoji);assert.equal(writes[0].color,bot.color)
    assert.equal(Object.hasOwn(writes[0],'avatarShape'),false)
    assert.equal(document.querySelectorAll('.ob-bot-runtime-grid select').length,6)
  } finally {await unmount()}
})

test('embedded delete requires confirmation; Escape cancels it without deleting', async()=>{
  await mount()
  try {
    await act(async()=>button('Delete').click())
    assert.equal(removed.length,0)
    assert.match(document.body.textContent,/Chat history stays/)
    await act(async()=>document.querySelector('.ob-bot-editor').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
    assert.equal(button('Delete permanently'),undefined);assert.equal(closes,0);assert.equal(removed.length,0)
  } finally {await unmount()}
})

test('failed deletion keeps the editor and bot; a successful receipt closes them',async()=>{
  await mount()
  try {
    await act(async()=>button('Delete').click())
    await act(async()=>button('Delete permanently').click())
    assert.deepEqual(removed,[bot.id]);assert.equal(closes,0);assert.equal(store.getState().bots.length,1)
    assert.ok(button('Delete permanently'))
    deleteResult={ok:true}
    await act(async()=>button('Delete permanently').click())
    assert.equal(closes,1);assert.equal(store.getState().bots.length,0)
  } finally {await unmount()}
})

test('keyboard and native menu toggle the sidebar once, with modal and typing ownership',async()=>{
  let toggles=0
  const listener=()=>toggles++
  function Shortcuts(){useShortcuts();return h('textarea',{id:'ob-prompt'})}
  store.patch({modal:null,approvals:[],streaming:true,settings})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
  window.addEventListener('openbot:toggle-sidebar',listener)
  try{
    await act(async()=>root.render(h(Shortcuts)))
    const input=document.querySelector('#ob-prompt');input.focus()
    await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'\\',metaKey:true,bubbles:true,cancelable:true})))
    assert.equal(toggles,1)
    await act(async()=>window.dispatchEvent(new window.Event('openbot:menu:toggle-sidebar')))
    assert.equal(toggles,2)
    await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true})))
    assert.equal(store.getState().modal,null)
    await act(async()=>store.patch({modal:'bots'}))
    await act(async()=>window.dispatchEvent(new window.Event('openbot:menu:toggle-sidebar')))
    assert.equal(toggles,2)
    await act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true})))
    assert.equal(store.getState().modal,'bots')
  } finally{window.removeEventListener('openbot:toggle-sidebar',listener);await unmount()}
})
