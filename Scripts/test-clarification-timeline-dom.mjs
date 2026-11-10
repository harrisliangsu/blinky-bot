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
const temp = await mkdtemp(resolve(tmpdir(), 'blinky-clarification-dom-'))
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
    builder.onResolve({ filter: /^\.\/(?:BotAvatar|GitHubDraftCards|GmailDraftCards|CalendarDraftCards|XDraftCards|SlackDraftCards)$/ }, args => ({ path: args.path.slice(2), namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'TaskClarificationCards' ? `export const useTaskClarifications=()=>({requests:[],error:false});export const TaskClarificationEntry=()=>null` : args.path === 'BotAvatar' ? `import React from 'react';export function BotAvatar(){return <span className="ob-avatar">B</span>}` : `export function ${args.path}(){return null}`, loader: 'tsx', resolveDir: repo }))
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
let calls = [], root, host, records = [], answerCalls = [], delayedList
let publish

window.openbot = {
  on: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  agent: { queue: async id => ({ sessionId: id, paused: false, items: [] }), stop: async () => { calls.push('stop'); return true } },
  tasks: {
    clarifications: async () => delayedList ?? records,
    answerClarification: async (id, answers) => {
      answerCalls.push({id,answers})
      const old = records.find(request => request.id === id)
      const next = { ...old, userAnswers: { ...old.userAnswers, ...answers }, updatedAt: old.updatedAt + 1 }
      next.status = next.questions.every(question => next.userAnswers?.[question.id]) ? 'answered' : 'waiting_user'
      if (next.status === 'answered') { next.answers = next.userAnswers; next.answeredBy = 'user' }
      records = records.map(request => request.id === id ? next : request)
      for (const listener of listeners) listener({type:'task-clarification-updated', request:next})
      return {ok:true,request:next}
    },
    cancelClarification: async id => { const next={...records.find(request=>request.id===id),status:'cancelled',updatedAt:999};return {ok:true,request:next} }
  },
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


const q = (id, extra={}) => ({id,taskId:'t',sourceSessionId:'main',executionSessionId:'agent',botId:'bot',createdAt:2,updatedAt:2,status:'waiting_user',questions:[{id:'q',header:'内部标题',question:'问题 '+id,kind:'preference',options:[{label:'选择一',description:'第一项'},{label:'选择二',description:'第二项'}]}],...extra})
const row = (id,time) => message(id,id,{createdAt:time})
const order = () => [...document.querySelector('.ob-transcript-content').children].flatMap(node=>node.dataset.messageId?[node.dataset.messageId]:node.dataset.taskClarificationId?['q:'+node.dataset.taskClarificationId]:[])
const answer = async id => { const card=document.querySelector(`[data-task-clarification-id="${id}"]`);await act(async()=>{card.querySelector('input[type=radio]').click()});await act(async()=>{card.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}))});await settle() }

test('actual Transcript keeps legacy answered cards between original messages, only question/answer remains, and new prose follows them', async()=>{
 records=[q('one',{status:'answered',answeredBy:'user',answers:{q:['用户原始回答']},updatedAt:999}),q('two',{createdAt:4})]
 await mount([row('before',1),row('task-clarification-one',2),row('middle',3),row('task-clarification-two',4),row('after',5)])
 try{
  assert.deepEqual(order(),['before','q:one','middle','q:two','after'])
  let card=document.querySelector('[data-task-clarification-id="one"]')
  assert.equal(card.textContent,'问题 one用户原始回答')
  assert.equal(card.querySelector('header,h3,button,input,textarea,[role=status]'),null)
  await answer('two')
  assert.equal(document.querySelector('[data-task-clarification-id="two"]').textContent,'问题 two选择一')
  await emit({type:'message-start',sessionId:'main',message:row('newest',10)})
  assert.deepEqual(order(),['before','q:one','middle','q:two','after','newest'])
  assert.equal(document.querySelectorAll('[data-task-clarification-id]').length,2)
  assert.doesNotMatch(card.textContent,/补充信息|当前对话|回答已接收/)
 }finally{await unmount()}
})
test('pending multi-question card shows one input at a time and retains earlier exact reply; cancellation/expiry never appear answered', async()=>{
 records=[q('multi',{questions:[...q('multi').questions,{...q('multi').questions[0],id:'next',question:'第二个问题'}]})]
 await mount([row('before',1)])
 try{
  assert.equal(document.querySelectorAll('.ob-clarification-question').length,1)
  assert.doesNotMatch(document.querySelector('.ob-task-clarification').textContent,/第二个问题/)
  await answer('multi')
  assert.equal(document.querySelectorAll('.ob-clarification-question').length,1)
  assert.match(document.querySelector('.ob-task-clarification').textContent,/选择一/)
  assert.match(document.querySelector('legend').textContent,/第二个问题/)
  await answer('multi')
  assert.equal(document.querySelector('form'),null)
  assert.equal(document.querySelectorAll('.ob-clarification-answers dd').length,2)
  for(const state of ['cancelled','expired']){
   await emit({type:'task-clarification-updated',request:q('closed-'+state,{status:state,createdAt:9,updatedAt:100})})
   const card=document.querySelector(`[data-task-clarification-id="closed-${state}"]`)
   assert.match(card.textContent,/未提供回答/);assert.equal(card.querySelector('form,dd'),null)
  }
 }finally{await unmount()}
})
test('history window does not relocate all old cards to bottom; expanding and remounting preserve every question and answer',async()=>{
 records=Array.from({length:30},(_,i)=>q('old'+i,{status:'answered',answeredBy:'user',answers:{q:['回答'+i]},createdAt:i*10+2}))
 const history=Array.from({length:260},(_,i)=>row('history'+i,i*10))
 await mount(history)
 try{
  assert.ok(document.querySelectorAll('[data-task-clarification-id]').length<30)
  assert.equal(order().at(-1),'history259')
  const earlier=document.querySelector('.ob-transcript-earlier button')??[...document.querySelectorAll('button')].find(button=>/earlier|更早|较早|之前/i.test(button.textContent))
  assert.ok(earlier)
  await act(async()=>earlier.click());await settle()
  assert.equal(document.querySelectorAll('[data-task-clarification-id]').length,30)
  assert.equal(order().at(-1),'history259')
 }finally{await unmount()}
 await mount(history)
 try{assert.equal(order().at(-1),'history259');assert.equal(document.querySelectorAll('[data-task-clarification-id="old29"]').length,0);const earlier=[...document.querySelectorAll('button')].find(button=>/earlier|更早|较早|之前/i.test(button.textContent));await act(async()=>earlier.click());await settle();assert.equal(document.querySelectorAll('[data-task-clarification-id="old29"]').length,1)}finally{await unmount()}
})
test('live canonical answer wins over stale initial history; cross-conversation cards cannot appear',async()=>{
 let release;delayedList=new Promise(resolve=>release=resolve);records=[]
 await mount([row('before',1),row('after',4)])
 try{
  await emit({type:'task-clarification-updated',request:q('race',{status:'answered',answeredBy:'user',answers:{q:['最新回答']},updatedAt:30})})
  await emit({type:'task-clarification-updated',request:q('foreign',{sourceSessionId:'elsewhere'})})
  await act(async()=>release([q('race',{updatedAt:2})]));await settle()
  assert.equal(document.querySelector('[data-task-clarification-id="race"]').textContent,'问题 race最新回答')
  assert.equal(document.querySelector('[data-task-clarification-id="foreign"]'),null)
  assert.deepEqual(order(),['before','q:race','after'])
 }finally{delayedList=undefined;await unmount()}
})
test('latest follows while active; user history intent survives new messages, answers and send events; End restores follow',async()=>{
 records=[q('scroll')];await mount([row('before',1)])
 try{
  const scroller=document.querySelector('.ob-transcript-scroller');let height=1000
  Object.defineProperties(scroller,{scrollHeight:{get:()=>height},clientHeight:{get:()=>100}})
  await act(async()=>{scroller.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))})
  assert.equal(scroller.scrollTop,900)
  await act(async()=>{scroller.dispatchEvent(new window.WheelEvent('wheel',{deltaY:-20,bubbles:true}));scroller.scrollTop=400})
  height=1500;await emit({type:'message-start',sessionId:'main',message:row('new',5)})
  assert.equal(scroller.scrollTop,400)
  await answer('scroll');assert.equal(scroller.scrollTop,400)
  await act(async()=>window.dispatchEvent(new window.CustomEvent('openbot:chat-sent',{detail:'main'})))
  assert.equal(scroller.scrollTop,400)
  await act(async()=>{scroller.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}))})
  assert.equal(scroller.scrollTop,1400)
 }finally{await unmount()}
})
