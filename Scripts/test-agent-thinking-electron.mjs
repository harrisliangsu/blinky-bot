// Real Electron/store/IPC/React. All messages and model events are synthetic.
// Run only in an isolated source copy; no installed App or real account is used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = path.resolve(import.meta.dirname, '..')
const root = process.env.BLINKY_THINKING_TEST_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-thinking-'))
const data = path.join(root, 'data'), evidence = path.join(root, 'evidence'), home = path.join(root, 'home')
for (const dir of [data, evidence, home, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(dir, { recursive: true })
const backends = Object.fromEntries(['codex','claude','claude-code','kimi','grok','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id => [id, { enabled: false }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', backends, memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false }))
await fs.writeFile(path.join(data, 'bots', 'thinking-bot.json'), JSON.stringify({ id: 'thinking-bot', name: 'Synthetic thinking Bot', emoji: 'B', color: '#888888', backendId: 'codex', modelId: 'synthetic', tools: [], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'thinking-home', createdAt: 1, updatedAt: 1 }))
const msg = (id, content, extra = {}) => ({ id, content, role: 'assistant', createdAt: 1, ...extra })
const saveSession = async (id, messages, archived = true) => fs.writeFile(path.join(data, 'sessions', id + '.json'), JSON.stringify({ id, title: id, cwd: root, mode: 'agent', botIds: ['thinking-bot'], activeBotId: 'thinking-bot', messages, todos: [], archived, createdAt: 1, updatedAt: 1 }))
await saveSession('thinking-home', Array.from({ length: 45 }, (_, i) => msg('home-' + i, ('Main chat ' + i + '\n').repeat(5), { role: i % 2 ? 'assistant' : 'user' })), false)
const traces = Array.from({ length: 305 }, (_, i) => ({ id: 'cmd-' + i, kind: 'commandExecution', phase: i === 304 ? 'started' : 'completed', detail: JSON.stringify({ command: 'synthetic-command-' + i, ...(i < 304 ? { exitCode: i === 303 ? 1 : 0 } : {}), aggregatedOutput: 'Synthetic output ' + i + ' token=synthetic-tool-secret', internalConfig: 'PRIVATE_CONFIG_SENTINEL' }) }))
for (const [id, status] of [['long', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['live', 'paused']]) {
  const messages = id === 'long' ? [
    ...Array.from({ length: 120 }, (_, i) => msg('history-' + i, 'Historical answer ' + i)),
    msg('thinking', 'Progress record token=synthetic-commentary-secret\n\n## Final answer\n\nReadable **body** with code `value`.', { reasoning: 'Recorded reasoning. '.repeat(600) + ' password=synthetic-thinking-secret', segments: [{ id: 'c', phase: 'commentary', text: 'Progress record token=synthetic-commentary-secret' }, { id: 'f', phase: 'final_answer', text: '## Final answer\n\nReadable **body** with code `value`.' }], agentTrace: traces }),
    msg('progress-only', 'Completed commentary stays in the activity section', { segments: [{ id: 'p', phase: 'commentary', text: 'Completed commentary stays in the activity section' }] }),
    msg('private', 'PRIVATE_INTERNAL_SENTINEL', { internal: true }), msg('system', 'PRIVATE_SYSTEM_SENTINEL', { role: 'system' })
  ] : id === 'live' ? [] : [msg(id, 'Saved ' + status, { reasoning: 'Saved reasoning', agentTrace: [{ id: 'unfinished-' + id, kind: 'commandExecution', phase: 'started', detail: '{"command":"synthetic-incomplete"}' }] })]
  await saveSession('thinking-' + id, messages)
  await fs.writeFile(path.join(data, 'tasks', id + '.json'), JSON.stringify({ id, title: 'Synthetic ' + id, prompt: 'Synthetic only', botId: 'thinking-bot', sessionId: 'thinking-' + id, status, createdAt: 1, updatedAt: 1, ...(id === 'failed' ? { error: 'Synthetic task failure' } : {}) }))
}
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const uiPort = await port(), mainPort = await port()
const executable = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: 'synthetic', LOGNAME: 'synthetic', SHELL: '/bin/zsh', TMPDIR: root, LANG: 'en_US.UTF-8', OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
const child = spawn(executable, [repo, `--inspect=127.0.0.1:${mainPort}`, `--remote-debugging-port=${uiPort}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(root, 'chromium')}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', seq = 0
const sockets = [], errors = [], result = { root, repo, pid: child.pid, realElectron: true, syntheticModel: true, realAccount: false, isolatedHome: home, toolCount: traces.length }
child.stdout.on('data', x => { logs += x }); child.stderr.on('data', x => { logs += x })
async function connect(debugPort, type) {
  let target
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Electron exited: ' + logs.slice(-1500))
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(x => !type || x.type === type); if (target) break } catch {}
    await delay(100)
  }
  if (!target) throw Error('No debugger target: ' + logs.slice(-1500))
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const pending = new Map()
  ws.onmessage = e => { const x = JSON.parse(e.data); if (x.method === 'Runtime.exceptionThrown') errors.push(x.params.exceptionDetails.text); const p = pending.get(x.id); if (p) { pending.delete(x.id); clearTimeout(p.timer); x.error ? p.reject(Error(JSON.stringify(x.error))) : p.resolve(x.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)) }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const x = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (x.exceptionDetails) throw Error(JSON.stringify(x.exceptionDetails)); return x.result.value }
  return { send, evaluate }
}
let ui, main
const wait = async expression => { for (let i = 0; i < 250; i++) { if (await ui.evaluate(expression)) return; await delay(40) } throw Error('Timeout: ' + expression) }
const click = async selector => { await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target');e.focus({preventScroll:true});e.click()})()`); await delay(70) }
const key = async (name, modifiers = 0) => {
  const code = ({ Enter: 13, Escape: 27, Tab: 9, ' ': 32 })[name]
  await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, modifiers, ...(name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, modifiers }); await delay(100)
}
const shot = async name => { const x = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, name + '.png'), Buffer.from(x.data, 'base64')) }
try {
  ui = await connect(uiPort, 'page'); main = await connect(mainPort); await ui.send('Runtime.enable')
  result.runtime = await main.evaluate(`(()=>{globalThis.__electron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return{electron:process.versions.electron,appPath:__electron.app.getAppPath(),userData:__electron.app.getPath('userData'),home:process.env.HOME}})()`)
  assert.equal(result.runtime.userData, data); assert.equal(result.runtime.home, home); assert.equal(result.runtime.appPath, repo)
  // A persisted running task is correctly recovered as interrupted on boot.
  // Seed paused data, then overlay a synthetic live task at the IPC boundary.
  await main.evaluate(`(()=>{globalThis.__counts={saved:0,live:0};globalThis.__live=[{id:'live-message',role:'assistant',content:'RAW_PROTOCOL_SENTINEL',reasoning:'Live recorded reasoning',segments:[{id:'progress',phase:'commentary',text:'Inspecting synthetic source'}],streaming:true,createdAt:1,agentTrace:[{id:'live-command',kind:'commandExecution',phase:'started',detail:'{"command":"synthetic-live"}'}]}];const h=__electron.ipcMain._invokeHandlers;for(const name of ['openbot:sessions:get','openbot:agent:live-messages','openbot:agent:liveMessages','openbot:tasks:summaries','openbot:tasks:get']){if(!h.has(name))continue;const original=h.get(name);h.set(name,async(...args)=>{const value=await original(...args);if(name.includes('tasks:')){const patch=t=>t?.id==='live'?{...t,status:'running'}:t;return Array.isArray(value)?value.map(patch):patch(value)}if(args[1]==='thinking-live'){if(name==='openbot:sessions:get')__counts.saved++;else{__counts.live++;return __live}}return value})}})()`)
  await wait(`!!document.querySelector('#ob-prompt')`)
  await ui.evaluate(`window.__longTasks=[];new PerformanceObserver(l=>__longTasks.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});window.__keys=[];document.addEventListener('keydown',e=>__keys.push({key:e.key,trusted:e.isTrusted}),true)`)
  await click('.ob-header-bot-trigger'); await wait(`!!document.querySelector('[data-agent-task-id=live]')`)
  assert.match(await ui.evaluate(`document.querySelector('#ob-bot-details [role=tab][aria-selected=true]').textContent`), /进行中/)
  assert.deepEqual(await main.evaluate('__counts'), { saved: 0, live: 0 })
  await ui.evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'UNSENT THINKING DRAFT');e.dispatchEvent(new Event('input',{bubbles:true}));window.__draft=e;window.__scroll=document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller');__scroll.scrollTop=73})()`)
  await click('[data-agent-task-id=live]'); await wait(`!!document.querySelector('.ob-agent-thinking-toggle')`)
  assert.equal(await ui.evaluate(`document.querySelectorAll('.ob-agent-transcript .ob-msg-answer').length`), 0)
  assert.equal(await ui.evaluate(`!!document.querySelector('.ob-agent-thinking-body')`), false)
  await main.evaluate('__electron.BrowserWindow.getAllWindows()[0].focus()')
  await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').focus()`); await key('Enter')
  await wait(`!!document.querySelector('.ob-tool-running')`)
  assert.equal(await ui.evaluate(`!!document.querySelector('.ob-tool-detail')`), false)
  await key('Tab'); result.keyboardTabTarget = await ui.evaluate(`document.activeElement.tagName`)
  await ui.evaluate(`document.querySelector('.ob-tool-row').focus()`); await key(' ')
  await wait(`!!document.querySelector('.ob-tool-detail')`)
  await shot('light-live-tools')
  const before = await main.evaluate('__counts.saved'), started = performance.now()
  await main.evaluate(`(()=>{const m=__live[0];m.segments.push({id:'answer',phase:'partial_answer',text:''});let n=0;const w=__electron.BrowserWindow.getAllWindows()[0].webContents;const timer=setInterval(()=>{m.segments[1].text+='Increment ';m.reasoning+=' reasoning';w.send('openbot:event',{type:'reasoning-delta',sessionId:'thinking-live',messageId:m.id,delta:' reasoning'});w.send('openbot:event',{type:'text-delta',sessionId:'thinking-live',messageId:m.id,delta:'Increment ',segment:{id:'answer',phase:'partial_answer',delta:'Increment '}});if(++n===120){clearInterval(timer);m.agentTrace.push({id:'live-command',kind:'commandExecution',phase:'completed',detail:'{"exitCode":0,"aggregatedOutput":"Synthetic live output"}'});w.send('openbot:event',{type:'agent-trace',sessionId:'thinking-live',messageId:m.id,entry:m.agentTrace.at(-1)})}},10)})()`)
  await wait(`document.querySelector('.ob-agent-transcript .ob-msg-answer')?.textContent.length>=1190`)
  await wait(`!!document.querySelector('.ob-tool-ok .ob-tool-detail')`)
  assert.equal(await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').getAttribute('aria-expanded')`), 'true')
  assert.equal(await main.evaluate('__counts.saved'), before, 'Streaming must not reread saved history')
  result.stream = { events: 240, elapsedMs: Math.round(performance.now() - started), savedReads: 0, retainedOpenTool: true }
  await shot('light-live-answer')
  await key('Escape'); await wait(`!document.querySelector('.ob-agent-session-view')`)
  await wait(`document.activeElement?.dataset.agentTaskId==='live'`)
  result.return = await ui.evaluate(`({sameDraft:document.querySelector('#ob-prompt')===__draft,draft:__draft.value,sameScroll:document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller')===__scroll,scroll:__scroll.scrollTop,focus:document.activeElement.dataset.agentTaskId})`)
  assert.deepEqual(result.return, { sameDraft: true, draft: 'UNSENT THINKING DRAFT', sameScroll: true, scroll: 73, focus: 'live' })
  await click('#ob-bot-details [role=tab]:nth-child(2)')
  const opened = performance.now(); await click('[data-agent-task-id=long]'); await wait(`document.querySelectorAll('.ob-agent-thinking-toggle').length===2`)
  result.longOpenMs = Math.round(performance.now() - opened)
  assert.equal(await ui.evaluate(`document.querySelectorAll('.ob-agent-transcript article.ob-msg').length`), 60)
  assert.equal(await ui.evaluate(`!!document.querySelector('.ob-tool')`), false)
  assert.doesNotMatch(await ui.evaluate(`document.querySelector('.ob-agent-transcript').textContent`), /PRIVATE_|RAW_PROTOCOL|synthetic-.*-secret/)
  assert.equal(await ui.evaluate(`document.querySelectorAll('.ob-agent-thinking')[1].closest('article').querySelector('.ob-msg-answer')`), null)
  await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').focus()`); await key('Enter')
  assert.equal(await ui.evaluate(`document.querySelectorAll('.ob-agent-thinking-tools > ol > li').length`), 30)
  assert.equal(await ui.evaluate(`document.querySelector('.ob-agent-thinking-record pre').textContent.length`), 4000)
  assert.match(await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').textContent`), /305 次工具调用.*1 失败.*1 结果未记录/)
  const ax = await ui.send('Accessibility.getFullAXTree'); result.accessibilityDisclosures = ax.nodes.filter(n=>n.role?.value==='button' && /思考与工具活动/.test(n.name?.value??'')).map(n=>({name:n.name.value,expanded:n.properties?.find(p=>p.name==='expanded')?.value?.value})); assert.equal(result.accessibilityDisclosures.length,2); assert.ok(result.accessibilityDisclosures.some(n=>n.expanded===true));
  await click('.ob-agent-tool-unknown .ob-tool-row'); assert.ok(await ui.evaluate(`!!document.querySelector('.ob-agent-tool-unknown .ob-tool-detail')`))
  await click('.ob-tool-failed .ob-tool-row'); await wait(`!!document.querySelector('.ob-tool-failed .ob-tool-output')`)
  for (const theme of ['light', 'dark']) {
    await ui.evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`); await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
    await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').scrollIntoView({block:'start'})`)
    await shot(theme + '-long-hierarchy')
    result[theme] = await ui.evaluate(`({body:getComputedStyle(document.querySelector('.ob-msg-answer')).color,thinking:getComputedStyle(document.querySelector('.ob-agent-thinking-record pre')).color,background:getComputedStyle(document.querySelector('.ob-agent-session-view')).backgroundColor})`)
  }
  await main.evaluate('__electron.BrowserWindow.getAllWindows()[0].setSize(900,700)'); await delay(100)
  await shot('dark-compact-keyboard')
  assert.ok(await ui.evaluate(`document.querySelector('.ob-agent-transcript').scrollWidth<=document.querySelector('.ob-agent-transcript').clientWidth+1`))
  await ui.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'forced-colors', value: 'active' }] }); await shot('forced-colors-reduced-motion')
  await ui.send('Emulation.setEmulatedMedia', { features: [] })
  const expanded = performance.now()
  const anchor = await ui.evaluate(`(()=>{const b=document.querySelector('.ob-agent-tools-earlier');b.scrollIntoView({block:'center'});const s=document.querySelector('.ob-agent-transcript .ob-transcript-scroller');return{top:s.scrollTop,height:s.scrollHeight}})()`)
  await click('.ob-agent-tools-earlier')
  result.earlierToolAnchor = await ui.evaluate(`(()=>{const s=document.querySelector('.ob-agent-transcript .ob-transcript-scroller');return{top:s.scrollTop,height:s.scrollHeight}})()`)
  assert.ok(Math.abs(result.earlierToolAnchor.top-anchor.top-result.earlierToolAnchor.height+anchor.height)<3, 'Earlier tool pagination preserves the viewport anchor')
  while (await ui.evaluate(`!document.querySelector('.ob-agent-tools-earlier').disabled`)) await click('.ob-agent-tools-earlier')
  result.expand305Ms = Math.round(performance.now() - expanded)
  assert.equal(await ui.evaluate(`document.querySelectorAll('.ob-agent-thinking-tools > ol > li').length`), 305)
  assert.doesNotMatch(await ui.evaluate(`document.querySelector('.ob-agent-transcript').textContent`), /PRIVATE_|RAW_PROTOCOL|synthetic-.*-secret/)
  while (await ui.evaluate(`!document.querySelector('.ob-agent-text-more').disabled`)) await click('.ob-agent-text-more')
  assert.ok(await ui.evaluate(`document.querySelector('.ob-agent-thinking-record pre').textContent.length>12000`))
  await click('.ob-agent-thinking-toggle')
  await ui.evaluate(`document.querySelector('.ob-agent-transcript .ob-msg-answer').scrollIntoView({block:'center'})`)
  await shot('dark-long-answer-collapsed')
  result.keyboardTrusted = await ui.evaluate(`__keys.filter(k=>['Enter',' ','Escape','Tab'].includes(k.key)).every(k=>k.trusted)`); assert.ok(result.keyboardTrusted)
  await key('Escape'); await wait(`!document.querySelector('.ob-agent-session-view')`)
  for (const id of ['failed', 'cancelled']) {
    await click(`[data-agent-task-id=${id}]`); await wait(`!!document.querySelector('.ob-agent-thinking-toggle')`)
    await click('.ob-agent-thinking-toggle'); assert.equal(await ui.evaluate(`!!document.querySelector('.ob-tool-running')`), false)
    assert.match(await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').textContent`), /结果未记录/)
    await shot('saved-' + id); await key('Escape'); await wait(`!document.querySelector('.ob-agent-session-view')`)
  }
  result.accessibilityNodes = (await ui.send('Accessibility.getFullAXTree')).nodes.length
  result.longTasks = await ui.evaluate(`({count:__longTasks.length,maxMs:Math.round(Math.max(0,...__longTasks)),totalMs:Math.round(__longTasks.reduce((a,b)=>a+b,0))})`)
  result.rendererErrors = errors; assert.deepEqual(errors, []); result.ok = true
} catch (error) { result.ok = false; result.failure = error.stack; if (ui) await shot('failure').catch(() => {}); throw error }
finally {
  if (main) await main.evaluate('__electron.app.quit()').catch(() => {})
  for (const ws of sockets) ws.close()
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await fs.writeFile(path.join(evidence, 'electron.log'), logs); await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result))
}
