// Pure Node + actual React components. No Electron, native UI, account or network.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'

const { Window } = await import(pathToFileURL(process.env.BLINKY_DOM_MODULE ?? './node_modules/happy-dom/lib/index.js').href)
const window = new Window({ url: 'https://isolated.invalid', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, enableFileSystemHttpRequests: false } })
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'DOMParser', 'Event', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : key === 'document' ? window.document : window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.fetch = window.fetch = () => { throw new Error('Unexpected network access') }
const repo = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(resolve(tmpdir(), 'blinky-reply-progress-dom-'))
after(async () => { await window.happyDOM.abort(); await window.happyDOM.close(); await stop(); await rm(temp, { recursive: true, force: true }) })
await symlink(resolve(repo, 'node_modules'), resolve(temp, 'node_modules'), 'dir')
const bundled = await build({
  stdin: { contents: `
    import React from 'react';
    export {createRoot} from 'react-dom/client';
    export {Transcript} from './src/renderer/src/components/Transcript';
    export {store} from './src/renderer/src/state/core';
    export {applyEvent} from './src/renderer/src/state/events';
    export const act=React.act, h=React.createElement;
  `, sourcefile: 'reply-progress-dom.tsx', resolveDir: repo, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' }, external: ['react', 'react/*', 'react-dom/*'],
  plugins: [{ name: 'isolate-unrelated-surfaces', setup(builder) {
    builder.onResolve({ filter: /^\.\/(?:BotAvatar|GitHubDraftCards|GmailDraftCards|CalendarDraftCards|XDraftCards|SlackDraftCards|TaskClarificationCards)$/ }, args => ({ path: args.path.slice(2), namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'BotAvatar' ? `import React from 'react';export function BotAvatar(){return <span className="ob-avatar">B</span>}` : `export function ${args.path}(){return null}`, loader: 'tsx', resolveDir: repo }))
  } }]
})
const file = resolve(temp, 'fixture.mjs')
await writeFile(file, bundled.outputFiles[0].text)
const { Transcript, store, applyEvent, act, h, createRoot } = await import(pathToFileURL(file).href)
const listeners = new Set()
const renderErrors = []
const originalError = console.error
console.error = (...args) => { renderErrors.push(args.join(' ')); originalError(...args) }
after(() => { console.error = originalError; assert.deepEqual(renderErrors, [], 'React reports no duplicate keys or rendering errors') })
let calls = [], root, host
window.openbot = {
  on: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  agent: { queue: async id => ({ sessionId: id, paused: false, items: [] }), stop: async () => { calls.push('stop'); return true } },
  sessions: { list: async () => [] }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (ms = 0) => { await act(async () => { await pause(ms) }) }
const session = id => ({ id, title: id, botIds: ['bot'], activeBotId: 'bot', cwd: '/isolated', mode: 'agent', createdAt: 1, updatedAt: 1 })
const message = (id, content = '', extra = {}) => ({ id, role: 'assistant', botId: 'bot', content, createdAt: 1, ...extra })
async function select(id, messages = [], streaming = false) {
  await act(async () => {
    const ids = store.resetMessages(messages)
    store.patch({ ready: true, currentSessionId: id, session: session(id), messageIds: ids, sessionLoading: false, runError: null, streaming, approvals: [], tasks: [], bots: [{ id: 'bot', name: 'Synthetic Bot', emoji: 'B', color: '#999' }], settings: { language: 'zh-CN' } })
  })
  await settle()
}
async function mount(messages = []) {
  calls = []
  await select('main', messages)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(h(Transcript)))
  await settle()
}
async function unmount() { await act(async () => root.unmount()); host.remove(); await settle(); assert.equal(listeners.size, 0) }
async function emit(event) {
  await act(async () => { applyEvent(event); for (const listener of listeners) listener(event) })
  await settle()
}
async function start(id = 'm') {
  await emit({ type: 'run-started', sessionId: 'main' })
  await emit({ type: 'message-start', sessionId: 'main', message: message(id, '', { streaming: true }) })
}
async function text(id, phase, delta, segmentId = phase) {
  await emit({ type: 'text-delta', sessionId: 'main', messageId: id, delta, segment: { id: segmentId, phase, delta } })
  await settle(10)
}
const status = () => document.querySelector('.ob-reply-progress')
const prose = () => [...document.querySelectorAll('.ob-msg-answer')].map(element => element.textContent).join('\n')
const trace = (phase, id = 'search', kind = 'webSearch', sessionId = 'main') => ({ type: 'agent-trace', sessionId, messageId: 'm', entry: { id, kind, phase, detail: 'PRIVATE_TOOL_DETAIL' } })

test('one run indicator survives streaming prose and message boundaries; no chat stop or fixed background notice', async () => {
  await mount()
  try {
    await start(); await settle(210)
    assert.match(status()?.textContent, /正在回复/)
    assert.equal(document.querySelectorAll('.ob-model-progress').length, 1)
    await text('m', 'commentary', '真实里程碑：已完成第一阶段。后台任务进行中是正文引用。')
    await text('m', 'partial_answer', '正文第一段')
    assert.match(prose(), /真实里程碑/); assert.match(prose(), /正文第一段/)
    assert.equal(document.querySelectorAll('.ob-model-progress').length, 1)
    await emit({ type: 'message-end', sessionId: 'main', messageId: 'm', content: '正文第一段', segments: [{ id: 'commentary', phase: 'commentary', text: '真实里程碑：已完成第一阶段。' }, { id: 'partial_answer', phase: 'partial_answer', text: '正文第一段' }] })
    assert.ok(status(), 'message-end is not run completion')
    await emit(trace('started')); assert.match(status()?.textContent, /正在检索/)
    await emit(trace('completed')); assert.match(status()?.textContent, /正在回复/)
    await emit({ type: 'done', sessionId: 'main', outcome: 'completed' })
    assert.equal(status(), null)
    assert.match(prose(), /真实里程碑/); assert.match(prose(), /正文第一段/)
    await act(async () => store.patch({ tasks: [{ id: 'background', sourceSessionId: 'main', status: 'running' }] }))
    assert.equal(status(), null)
    assert.equal(document.querySelector('.ob-transcript-working'), null)
    assert.equal([...document.querySelectorAll('button')].some(button => /停止工作|Stop work/.test(button.textContent)), false)
    assert.deepEqual(calls, [])
  } finally { await unmount() }
})

test('failures and all terminal outcomes remove the indicator immediately and retain partial prose/errors', async () => {
  await mount()
  try {
    for (const outcome of ['completed', 'cancelled', 'failed']) {
      await start(outcome); await settle(200)
      assert.ok(status())
      await text(outcome, 'partial_answer', `partial-${outcome}`)
      await emit({ type: 'done', sessionId: 'main', outcome })
      assert.equal(status(), null); assert.match(prose(), new RegExp(`partial-${outcome}`))
    }
    await start('error'); await settle(200)
    await text('error', 'partial_answer', '错误前的正文')
    await emit({ type: 'error', sessionId: 'main', message: 'Synthetic stream failure' })
    assert.equal(status(), null); assert.match(document.body.textContent, /Synthetic stream failure/)
    assert.match(prose(), /错误前的正文/)
    await emit(trace('started')); assert.equal(status(), null, 'late operation cannot revive a terminated reply')
  } finally { await unmount() }
})

test('short replies never flash; waiting, reconnect and return-to-chat are truthful and scoped', async () => {
  await mount()
  try {
    await start('short'); await text('short', 'final_answer', '快回复')
    await emit({ type: 'done', sessionId: 'main' }); await settle(220)
    assert.equal(status(), null)
    await start(); await settle(200)
    await emit({ type: 'tool-call', sessionId: 'main', messageId: 'm', call: { id: 'call', name: 'search', args: { secret: 'PRIVATE' } } })
    assert.match(status()?.textContent, /正在处理工具请求/)
    await act(async () => store.patch({ approvals: [{ id: 'approve', sessionId: 'main', summary: 'Synthetic approval', kind: 'fetch', toolName: 'fetch', target: 'synthetic', detail: '', createdAt: 1 }] }))
    assert.match(status()?.textContent, /等待确认/)
    await act(async () => store.patch({ approvals: [] }))
    await emit({ type: 'backend-notice', sessionId: 'main', category: 'reconnect', message: 'Synthetic reconnect' })
    assert.match(status()?.textContent, /正在重新连接/)
    await emit({ type: 'tool-result', sessionId: 'main', messageId: 'tool', result: { callId: 'call', name: 'search', ok: false, output: 'PRIVATE' } })
    assert.match(status()?.textContent, /正在回复/)
    await select('other'); assert.equal(status(), null)
    await emit(trace('started')); assert.equal(status(), null)
    // Returning with a live snapshot uses a neutral state until fresh events;
    // no old operation is inferred from a saved history or replayed as active.
    await select('main', [message('return', '', { streaming: true, segments: [{ id: 'body', phase: 'partial_answer', text: '返回后正文' }] })], true)
    await settle(200)
    assert.match(status()?.textContent, /正在回复/)
    assert.match(prose(), /返回后正文/)
    await emit(trace('started', 'executor-search', 'webSearch', 'executor'))
    assert.match(status()?.textContent, /正在回复/)
    await emit({ type: 'done', sessionId: 'main' }); assert.equal(status(), null)
    assert.doesNotMatch(document.body.textContent, /PRIVATE/)
  } finally { await unmount() }
})

test('long conversation, public unphased text, accessibility and reduced-motion policy', async () => {
  await mount(Array.from({ length: 1000 }, (_, index) => message(`history-${index}`, `saved-${index}`)))
  try {
    assert.equal(document.querySelectorAll('.ob-msg-assistant').length, 200)
    await start(); await settle(200)
    const element = status()
    assert.equal(element.getAttribute('role'), 'status')
    assert.equal(element.getAttribute('aria-live'), 'polite')
    assert.equal(element.getAttribute('aria-atomic'), 'true')
    assert.equal(element.querySelector('.ob-reply-progress-avatar').getAttribute('aria-hidden'), 'true')
    assert.equal(element.querySelector('button,[tabindex]'), null)
    for (let index = 0; index < 40; index++) await text('m', 'partial_answer', `token-${index} `, 'visible-unphased')
    assert.equal(document.querySelectorAll('.ob-model-progress').length, 1)
    assert.match(prose(), /token-39/)
    await act(async () => store.patch({ settings: { language: 'en', theme: 'dark' } }))
    assert.match(status()?.textContent, /Responding/)
    await emit({ type: 'done', sessionId: 'main' }); assert.equal(status(), null)
    const css = await readFile(resolve(repo, 'src/renderer/src/components/ReplyProgress.css'), 'utf8')
    assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /animation: none/)
    assert.match(css, /forced-colors: active/)
  } finally { await unmount() }
})

test('End on the conversation restores follow while editable fields and modified keys retain native behavior', async () => {
  await mount()
  try {
    const scroller = document.querySelector('.ob-transcript-scroller')
    let height = 1000
    Object.defineProperties(scroller, { scrollHeight: { get: () => height }, clientHeight: { get: () => 100 } })
    const press = async (target, options = {}) => {
      const event = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true, ...options })
      await act(async () => target.dispatchEvent(event))
      return event
    }
    scroller.scrollTop = 300
    const input = document.createElement('textarea'); scroller.append(input)
    assert.equal((await press(input)).defaultPrevented, false)
    assert.equal(scroller.scrollTop, 300)
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      assert.equal((await press(scroller, { [modifier]: true })).defaultPrevented, false)
      assert.equal(scroller.scrollTop, 300)
    }
    assert.equal((await press(scroller)).defaultPrevented, true)
    assert.equal(scroller.scrollTop, 900)
    height = 1400
    await start('after-end')
    assert.equal(scroller.scrollTop, 1300, 'New streamed layout keeps the explicit End follow intent')
    input.remove()
  } finally { await unmount() }
})
