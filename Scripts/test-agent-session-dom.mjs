// Pure Node DOM integration. Never imports/launches Electron or reads app data.
// Use BLINKY_DOM_MODULE for an explicitly installed, isolated happy-dom dependency.
// BLINKY_DOM_MODULE=/path/to/happy-dom/lib/index.js node --test Scripts/test-agent-session-dom.mjs
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'

const { Window } = await import(pathToFileURL(process.env.BLINKY_DOM_MODULE ?? './node_modules/happy-dom/lib/index.js').href)
const window = new Window({ url: 'https://isolated.invalid', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableComputedStyleRendering: true, enableFileSystemHttpRequests: false } })
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'DOMParser', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'ResizeObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : key === 'document' ? window.document : window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// No HTTP, IPC, subprocess or native UI bridge exists in this test process.
globalThis.fetch = window.fetch = () => { throw new Error('Unexpected network access') }

const temp = await mkdtemp(resolve(tmpdir(), 'blinky-agent-dom-'))
after(async () => {
  await window.happyDOM.abort(); await window.happyDOM.close(); await stop(); await rm(temp, { recursive: true, force: true })
})
const rootDir = resolve(import.meta.dirname, '..')
const styles = document.createElement('style')
styles.textContent = await readFile(resolve(rootDir, 'src/renderer/src/components/AppHeader.css'), 'utf8') + '\n' + await readFile(resolve(rootDir, 'src/renderer/src/components/AgentSessionView.css'), 'utf8')
document.head.append(styles)
// Keep React unbundled: its Node act() scheduler uses timers.setImmediate.
// Bundling the CJS scheduler into ESM falls back to browser MessageChannels,
// which leave Node worker ports alive after otherwise completed tests.
await symlink(resolve(rootDir, 'node_modules'), resolve(temp, 'node_modules'), 'dir')
const bundled = await build({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {BotDetailsPanel} from './src/renderer/src/components/BotDetailsPanel';
    import {AgentSessionWorkspace, AgentMainSurface} from './src/renderer/src/components/AgentSessionWorkspace';
    import {Modal} from './src/renderer/src/components/Modal';
    import {useShortcuts} from './src/renderer/src/lib/useShortcuts';
    import {store} from './src/renderer/src/state/core';
    import {useAppState} from './src/renderer/src/state/hooks';
    export {store, createRoot}; export const act = React.act; export const createElement = React.createElement;
    export function Fixture() {
      const [details, setDetails] = useState(true); const {modal} = useAppState();
      useShortcuts(details, () => setDetails(false));
      return <AgentSessionWorkspace><div className="ob-app"><main className="ob-main is-chat"><AgentMainSurface>
        <header className="ob-header"><button className="ob-header-bot-trigger" onClick={() => setDetails(v => !v)}>Bot details</button></header>
        <div id="main-scroll"><p>ORIGINAL MAIN CHAT</p><textarea id="ob-prompt" defaultValue="MAIN UNSENT" /></div>
      </AgentMainSurface></main>{details && <BotDetailsPanel onClose={() => setDetails(false)}/>}
      {modal && <Modal title="Upper dialog" onClose={() => store.setModal(null)}><input aria-label="Dialog input"/></Modal>}
      </div></AgentSessionWorkspace>;
    }`, resolveDir: rootDir, sourcefile: 'agent-dom-fixture.tsx', loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  external: ['react', 'react/*', 'react-dom/*'],
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'isolate-existing-bot-editor', setup(builder) {
    // Config internals are outside this change. Keep an unsaved field mounted
    // to detect accidental replacement/unmount by the new central surface.
    builder.onResolve({ filter: /^\.\/BotEditor$/ }, args => args.importer.endsWith('/BotDetailsPanel.tsx') ? { path: 'editor', namespace: 'fixture' } : undefined)
    // Avatar bitmaps/animation are verified by their dedicated real-Electron
    // suite. Vite's asset glob is not executable in a plain Node DOM bundle.
    builder.onResolve({ filter: /^\.\/BotAvatar$/ }, () => ({ path: 'avatar', namespace: 'avatar-fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'avatar-fixture' }, () => ({ contents: `import React from 'react'; export function BotAvatar(){return <span aria-hidden="true">B</span>}`, loader: 'tsx', resolveDir: rootDir }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import React from 'react'; export function BotEditor(){return <textarea aria-label="Unsaved Bot config" defaultValue="CONFIG UNSENT"/>}`, loader: 'tsx', resolveDir: rootDir }))
  } }]
})
const bundlePath = resolve(temp, 'fixture.mjs')
await writeFile(bundlePath, bundled.outputFiles[0].text)
const { Fixture, store, createRoot, act, createElement } = await import(pathToFileURL(bundlePath).href)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (ms = 85) => { await act(async () => { await pause(ms) }) }
const click = async element => { assert.ok(element, 'click target exists'); element.focus(); await act(async () => { element.click() }); await settle() }
const key = async (target, value, extra = {}) => { await act(async () => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })) }); await settle(20) }
const findButton = text => [...document.querySelectorAll('button')].find(button => button.textContent.includes(text))
const task = (id, status, patch = {}) => ({ id, title: `Task ${id}`, prompt: `Request ${id}`, status, botId: 'bot', sessionId: `exec-${id}`, createdAt: 1, updatedAt: 1, ...patch })
const message = (id, content, patch = {}) => ({ id, content, role: 'assistant', createdAt: 1, ...patch })
const session = (id, messages = [], patch = {}) => ({ id, title: id, botIds: ['bot'], activeBotId: 'bot', cwd: '/isolated', mode: 'agent', todos: [], messages, createdAt: 1, updatedAt: 1, ...patch })
let host, root, listeners, records, live, calls, tasks, failList, failReads, failLive
const unexpected = name => async () => { calls.push(name); throw new Error(`Unexpected write: ${name}`) }
async function mount(values = []) {
  listeners = new Set(); records = new Map(); live = new Map(); calls = []; tasks = values; failList = failReads = failLive = false
  window.openbot = {
    on: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    tasks: {
      summaries: async () => { calls.push('tasks.summaries'); if (failList) throw new Error('list failed'); return structuredClone(tasks.map(({ prompt, result, review, acceptance, ...summary }) => ({ ...summary, hasReview: Boolean(review) }))) },
      get: async id => { calls.push('tasks.get'); return structuredClone(tasks.find(task => task.id === id) ?? null) },
      cancel: unexpected('tasks.cancel'), create: unexpected('tasks.create') },
    sessions: { get: async id => { calls.push(`sessions.get:${id}`); if (failReads) throw new Error('read failed'); return structuredClone(records.get(id) ?? null) }, setActiveBot: unexpected('sessions.setActiveBot'), create: unexpected('sessions.create') },
    agent: { liveMessages: async id => { calls.push(`agent.liveMessages:${id}`); if (failLive) throw new Error('live failed'); return structuredClone(live.get(id) ?? []) }, stop: unexpected('agent.stop'), send: unexpected('agent.send'), steer: unexpected('agent.steer'), start: unexpected('agent.start') },
    routines: { list: async () => { calls.push('routines.list'); return [] } }
  }
  store.patch({ ready: true, session: session('main'), currentSessionId: 'main', tasks: values, bots: [{ id: 'bot', name: 'Lead', emoji: 'B', color: '#fff' }], settings: { language: 'zh-CN' }, routines: [], routinesError: null, modal: null, streaming: true, approvals: [], projectHome: false })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(createElement(Fixture)) }); await settle()
}
async function unmount() { await act(async () => root.unmount()); host.remove(); await settle(5); assert.equal(listeners.size, 0) }
async function emit(event) { await act(async () => { if (event.type === 'task-updated') store.patch({ tasks: [event.task, ...store.getState().tasks.filter(task => task.id !== event.task.id)] }); for (const listener of listeners) listener(event) }); await settle() }
const assertReadOnly = () => assert.ok(calls.every(name => /^(tasks\.summaries|tasks\.get|routines\.list|sessions\.get:|agent\.liveMessages:)/.test(name)), calls.join(', '))

test('task Tabs default active; empty/list failure and queued → running → failed/cancelled states are honest', async () => {
  await mount()
  try {
    assert.match(document.querySelector('[role=tabpanel]').textContent, /暂无进行中的任务/)
    assert.equal(window.getComputedStyle(document.querySelector('main .ob-header')).position, 'absolute', 'chat header retains its original overlay layout through the underlay wrapper')
    const active = document.querySelector('[role=tab][aria-selected=true]')
    assert.match(active.textContent, /进行中/)
    await key(active, 'ArrowRight')
    assert.equal(document.activeElement.textContent.trim(), '已结束 0')
    assert.match(document.querySelector('[role=tabpanel]').textContent, /暂无已结束的任务/)
    await key(document.activeElement, 'Home')
    await emit({ type: 'task-updated', task: task('one', 'queued') })
    assert.match(document.querySelector('[data-agent-task-id=one]').textContent, /排队中/)
    await emit({ type: 'task-updated', task: task('one', 'running', { updatedAt: 2 }) })
    assert.match(document.querySelector('[data-agent-task-id=one]').textContent, /执行中/)
    await emit({ type: 'task-updated', task: task('one', 'failed', { updatedAt: 3, error: 'Explicit failure' }) })
    assert.equal(document.querySelector('[data-agent-task-id=one]'), null)
    await emit({ type: 'task-updated', task: task('two', 'cancelled', { updatedAt: 3 }) })
    await click(findButton('已结束'))
    assert.match(document.querySelector('[data-agent-task-id=one]').textContent, /失败/)
    assert.match(document.querySelector('[data-agent-task-id=two]').textContent, /已取消/)
    assert.doesNotMatch(document.querySelector('[role=tabpanel]').textContent, /成功/)
    assertReadOnly()
  } finally { await unmount() }
  await mount([task('stale', 'queued')])
  try {
    failList = true
    await act(async () => store.patch({ session: { ...store.getState().session, activeBotId: 'other' }, bots: [...store.getState().bots, { id: 'other', name: 'Other' }] })); await settle()
    assert.match(document.querySelector('[role=alert]').textContent, /无法刷新任务列表/)
    failList = false
    await click(findButton('重试'))
    assert.equal(document.querySelector('.ob-agent-list-error'), null)
  } finally { await unmount() }
})

test('title opens central native-style messages/tools/diffs, live updates, safe return and upper-dialog Escape', async () => {
  await mount([task('active', 'running'), task('failed', 'failed', { error: 'Failed execution' }), task('cancel', 'cancelled')])
  try {
    records.set('exec-active', session('exec-active', [message('user', 'Synthetic request', { role: 'user' }), message('hidden', 'PRIVATE_INTERNAL', { internal: true }), message('system', 'PRIVATE_SYSTEM', { role: 'system' })]))
    live.set('exec-active', [message('answer', 'First', { streaming: true, reasoning: 'Recorded reasoning', segments: [{ id: 'text', phase: 'partial_answer', text: '**First**' }], agentTrace: [{ id: 'cmd', kind: 'commandExecution', phase: 'started', detail: '{"command":"printf ok","cwd":"/isolated","internalConfig":"PRIVATE_PROTOCOL"}' }] })])
    const draft = document.querySelector('#ob-prompt'), config = document.querySelector('[aria-label="Unsaved Bot config"]'), mainScroll = document.querySelector('#main-scroll')
    draft.value = 'KEEP MY UNSENT DRAFT'; config.value = 'KEEP MY CONFIG'; mainScroll.scrollTop = 93
    const open = document.querySelector('[data-agent-task-id=active]')
    document.querySelector('main .ob-header').classList.add('is-sidebar-hidden')
    document.documentElement.style.setProperty('--ob-space-20', '80px')
    document.documentElement.dataset.obInputMode = 'keyboard'
    await click(open)
    assert.ok(document.querySelector('main .ob-agent-session-view'))
    assert.equal(window.getComputedStyle(document.querySelector('.ob-agent-session-head')).paddingLeft, '80px', 'hidden sidebar inherits the header safe-area spacing; this is not native pixel acceptance')
    assert.equal(document.querySelector('#ob-bot-details .ob-agent-transcript'), null)
    assert.equal(store.getState().currentSessionId, 'main')
    assert.equal(document.querySelector('.ob-agent-main-underlay').hasAttribute('inert'), true)
    assert.equal(document.activeElement.getAttribute('aria-label'), '关闭 Agent 会话，返回主聊天')
    await key(document.activeElement, 'Escape', { repeat: true })
    await key(document.activeElement, 'Escape', { isComposing: true })
    assert.ok(document.querySelector('.ob-agent-session-view'), 'repeated/composing Escape cannot close or stop work')
    assert.ok(document.querySelector('.ob-agent-transcript .ob-md strong'))
    const thinking = document.querySelector('.ob-agent-thinking-toggle')
    assert.equal(thinking.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('.ob-agent-thinking-body'), null, 'collapsed thinking does not mount tool output or diffs')
    assert.match(thinking.textContent, /思考与工具活动.*1 次工具调用.*1 进行中/)
    await click(thinking)
    assert.equal(thinking.getAttribute('aria-expanded'), 'true')
    assert.equal(document.getElementById(thinking.getAttribute('aria-controls')).getAttribute('aria-labelledby'), thinking.id)
    assert.match(document.querySelector('.ob-agent-thinking-record').textContent, /Recorded reasoning/)
    assert.ok(document.querySelector('.ob-agent-thinking-tools > ol > li .ob-tool-running'))
    assert.ok(document.querySelector('.ob-agent-transcript .ob-tool-running'))
    assert.doesNotMatch(document.querySelector('.ob-agent-session-view').textContent, /PRIVATE_INTERNAL|PRIVATE_SYSTEM|PRIVATE_PROTOCOL|internalConfig/)
    assert.equal(document.querySelector('.ob-msg-answer').closest('.ob-agent-thinking'), null, 'answer is separate from thinking and nested tools')
    live.set('exec-active', [message('answer', 'Second', { streaming: true, segments: [{ id: 'text', phase: 'partial_answer', text: '**Second**' }], agentTrace: [
      { id: 'cmd', kind: 'commandExecution', phase: 'completed', detail: '{"command":"printf ok","aggregatedOutput":"ok","exitCode":0}' },
      { id: 'file', kind: 'fileChange', phase: 'completed', detail: JSON.stringify({ status: 'completed', changes: [{ path: 'demo.ts', diff: '@@ -1 +1 @@\n-old\n+new' }] }) }
    ] })])
    await emit({ type: 'text-delta', sessionId: 'exec-active', messageId: 'answer', delta: 'Second' })
    assert.equal(document.querySelector('.ob-agent-transcript .ob-md strong').textContent, 'Second')
    assert.equal(thinking.getAttribute('aria-expanded'), 'true', 'live updates preserve the reader disclosure choice')
    assert.match(thinking.textContent, /2 次工具调用/)
    assert.equal(document.querySelector('.ob-tool-running'), null)
    const edit = [...document.querySelectorAll('.ob-tool-row')].find(button => button.textContent.includes('edit_file'))
    await click(edit)
    assert.ok(document.querySelector('.ob-diff'))
    await act(async () => store.setModal('settings')); await settle()
    await key(document.querySelector('[role=dialog] input'), 'Escape')
    assert.equal(document.querySelector('[role=dialog]'), null)
    assert.ok(document.querySelector('.ob-agent-session-view'), 'upper dialog closes before execution view')
    await key(document.activeElement, 'Escape')
    assert.equal(document.querySelector('.ob-agent-session-view'), null)
    assert.ok(document.querySelector('#ob-bot-details'), 'details stays open')
    assert.equal(document.activeElement, open)
    assert.equal(document.querySelector('#ob-prompt'), draft)
    assert.equal(draft.value, 'KEEP MY UNSENT DRAFT')
    assert.equal(mainScroll.scrollTop, 93)
    assert.equal(config.value, 'KEEP MY CONFIG')
    assert.equal(document.querySelector('[role=tab][aria-selected=true]').textContent.trim(), '进行中 1')
    // A title can vanish when the task ends; return to the selected task tab.
    document.documentElement.dataset.obInputMode = 'pointer'
    await click(open)
    await emit({ type: 'task-updated', task: task('active', 'failed', { updatedAt: 5, error: 'Execution failed' }) })
    assert.match(document.querySelector('[data-agent-session-status]').textContent, /失败/)
    assert.equal(document.querySelector('.ob-tool-running'), null)
    await click(findButton('返回主聊天'))
    assert.equal(document.activeElement.getAttribute('role'), 'tab')
    assert.ok(document.activeElement.hasAttribute('data-ob-pointer-focus-restored'))
    assert.ok(document.querySelector('#ob-bot-details'))
    await key(document.activeElement, 'Escape')
    assert.equal(document.querySelector('#ob-bot-details'), null)
    assertReadOnly()
  } finally { await unmount() }
})

test('ended failure/cancel, missing/no-trace/error, foreign scope, source switch and cleanup never run tasks', async () => {
  await mount([task('failure', 'failed', { error: 'TASK FAILURE' }), task('cancel', 'cancelled'), task('done', 'completed'), task('missing', 'completed'), task('foreign', 'completed')])
  try {
    records.set('exec-failure', session('exec-failure', [message('failed-message', '', { toolCalls: [{ id: 'no-result', name: 'shell', args: { command: 'false' } }] })]))
    records.set('exec-cancel', session('exec-cancel'))
    records.set('exec-done', session('exec-done', [message('done', 'Saved answer ![remote](https://external.invalid/collect)\n[unsafe action](https://external.invalid/action)\npassword=SYNTHETIC_PRIVATE')]))
    records.set('exec-foreign', session('exec-foreign', [message('secret', 'FOREIGN_PRIVATE')], { botIds: ['other'] }))
    await click(findButton('已结束'))
    await click(document.querySelector('[data-agent-task-id=failure]'))
    assert.match(document.querySelector('.ob-agent-session-view [role=alert]').textContent, /TASK FAILURE/)
    assert.match(document.querySelector('.ob-agent-thinking-toggle').textContent, /1 结果未记录/)
    await click(document.querySelector('.ob-agent-thinking-toggle'))
    assert.ok(document.querySelector('.ob-agent-tool-unknown'))
    assert.equal(document.querySelector('.ob-tool-running'), null)
    await click(findButton('返回主聊天'))
    assert.match(document.querySelector('[role=tab][aria-selected=true]').textContent, /已结束/)
    await click(document.querySelector('[data-agent-task-id=cancel]'))
    assert.match(document.querySelector('.ob-agent-session-view').textContent, /任务已取消|没有可展示的执行消息/)
    await click(findButton('返回主聊天'))
    await click(document.querySelector('[data-agent-task-id=missing]'))
    assert.match(document.querySelector('.ob-agent-session-view [role=alert]').textContent, /未读取到执行会话/)
    await click(findButton('返回主聊天'))
    await click(document.querySelector('[data-agent-task-id=foreign]'))
    assert.match(document.querySelector('.ob-agent-session-view [role=alert]').textContent, /不属于该任务/)
    assert.doesNotMatch(document.querySelector('.ob-agent-session-view').textContent, /FOREIGN_PRIVATE/)
    await click(findButton('返回主聊天'))
    await click(document.querySelector('[data-agent-task-id=done]'))
    assert.match(document.querySelector('.ob-agent-session-view').textContent, /尚无工具活动记录/)
    assert.doesNotMatch(document.querySelector('.ob-agent-session-view').textContent, /SYNTHETIC_PRIVATE/)
    assert.equal(document.querySelector('.ob-agent-session-view img, .ob-agent-session-view a[href]'), null)
    failReads = true
    await emit({ type: 'done', sessionId: 'exec-done' })
    assert.match(document.querySelector('.ob-agent-session-view [role=alert]').textContent, /无法刷新/)
    assert.match(document.querySelector('.ob-agent-transcript .ob-md').textContent, /Saved answer/)
    failReads = false
    await click(findButton('重试'))
    assert.equal(document.querySelector('.ob-agent-session-view [role=alert]'), null)
    failLive = true
    await emit({ type: 'done', sessionId: 'exec-done' })
    assert.match(document.querySelector('.ob-agent-session-view').textContent, /实时记录暂不可用/)
    assert.match(document.querySelector('.ob-agent-transcript .ob-md').textContent, /Saved answer/)
    await act(async () => store.patch({ currentSessionId: 'other-main', session: session('other-main') })); await settle()
    assert.equal(document.querySelector('.ob-agent-session-view'), null)
    assert.equal(listeners.size, 0)
    assertReadOnly()
  } finally { await unmount() }
})

test('App integration only wraps the existing main surface; no global session selection is added', async () => {
  const app = await readFile(resolve(rootDir, 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(app, /<main[^>]*>\s*<AgentMainSurface>/)
  assert.ok(app.indexOf('<BotDetailsPanel') > app.indexOf('</main>'))
  const workspace = await readFile(resolve(rootDir, 'src/renderer/src/components/AgentSessionWorkspace.tsx'), 'utf8')
  assert.doesNotMatch(workspace, /selectSession\(|sendTurn\(|stopTurn\(|sessions\.create|tasks\.create/)
})

test('long conversations and tool groups remain incremental, with failed/unknown results visible while collapsed', async () => {
  await mount([task('long', 'failed')])
  try {
    const history = Array.from({ length: 120 }, (_, index) => message(`history-${index}`, `Historical answer ${index}`))
    const trace = Array.from({ length: 65 }, (_, index) => ({ id: `tool-${index}`, kind: 'commandExecution', phase: 'completed', detail: JSON.stringify({ command: `synthetic-${index}`, exitCode: index === 64 ? 1 : 0, aggregatedOutput: `Synthetic output ${index}` }) }))
    history.push(message('last', 'Final visible answer', { reasoning: 'Recorded long-run thinking', agentTrace: trace }))
    records.set('exec-long', session('exec-long', history))
    await click(findButton('已结束'))
    await click(document.querySelector('[data-agent-task-id=long]'))
    assert.equal(document.querySelectorAll('.ob-agent-transcript article.ob-msg').length, 60)
    const thinking = document.querySelector('.ob-agent-thinking-toggle')
    assert.match(thinking.textContent, /65 次工具调用.*1 失败/)
    assert.equal(document.querySelector('.ob-agent-thinking-tools'), null)
    await click(thinking)
    assert.equal(document.querySelectorAll('.ob-agent-thinking-tools > ol > li').length, 30)
    assert.equal(document.querySelector('.ob-tool-failed .ob-tool-detail'), null, 'individual tool output remains lazy within the open thinking group')
    const failed = document.querySelector('.ob-tool-failed .ob-tool-row')
    assert.equal(failed.getAttribute('aria-expanded'), 'false')
    await click(failed)
    assert.match(document.querySelector('.ob-tool-failed .ob-tool-output').textContent, /Synthetic output 64/)
    await click(findButton('显示更早的工具活动'))
    assert.equal(document.querySelectorAll('.ob-agent-thinking-tools > ol > li').length, 60)
    await click(findButton('显示更早的工具活动'))
    assert.equal(document.querySelectorAll('.ob-agent-thinking-tools > ol > li').length, 65)
    assert.equal(findButton('显示更早的工具活动'), undefined)
    await click(thinking)
    assert.equal(document.querySelector('.ob-agent-thinking-body'), null)
    assert.match(document.querySelector('.ob-msg-answer:last-child').textContent, /Historical answer|Final visible answer/)
    await click(findButton('显示更早的消息'))
    assert.equal(document.querySelectorAll('.ob-agent-transcript article.ob-msg').length, 120)
    assertReadOnly()
  } finally { await unmount() }
})

test('a continued execution conversation refreshes while the selected earlier task stays failed', async () => {
  await mount([task('old', 'failed', { sessionId: 'shared', error: 'Earlier attempt failed' }), task('next', 'running', { sessionId: 'shared', continuedFromTaskId: 'old' })])
  try {
    records.set('shared', session('shared', [message('old-record', 'Earlier output')]))
    live.set('shared', [message('new-step', '', { streaming: true, agentTrace: [{ id: 'continuing', kind: 'commandExecution', phase: 'started', detail: '{"command":"echo continuing"}' }] })])
    await click(findButton('已结束'))
    await click(document.querySelector('[data-agent-task-id=old]'))
    assert.match(document.querySelector('[data-agent-session-status]').textContent, /失败/)
    assert.match(document.querySelector('.ob-agent-session-view').textContent, /同一执行会话仍有未结束的任务/)
    assert.match(document.querySelector('.ob-agent-thinking-toggle').textContent, /1 进行中/)
    await click(document.querySelector('.ob-agent-thinking-toggle'))
    assert.ok(document.querySelector('.ob-tool-running'))
    live.set('shared', [])
    records.set('shared', session('shared', [message('old-record', 'Earlier output'), message('new-step', 'Continuation stopped')]))
    await emit({ type: 'task-updated', task: task('next', 'cancelled', { sessionId: 'shared', continuedFromTaskId: 'old', updatedAt: 5 }) })
    assert.match(document.querySelector('.ob-agent-transcript').textContent, /Continuation stopped/)
    assert.match(document.querySelector('[data-agent-session-status]').textContent, /失败/)
    assert.equal(document.querySelector('.ob-tool-running'), null)
    assertReadOnly()
  } finally { await unmount() }
})
