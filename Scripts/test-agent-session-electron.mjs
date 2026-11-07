// Real Electron + real IPC/store/renderer, isolated synthetic sessions and a
// local Codex-protocol fixture. Never calls a real account, browser or tool.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'

if (process.platform !== 'darwin') throw new Error('Real macOS Electron required')
const repo = process.cwd(), root = process.env.BLINKY_AGENT_TEST_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-agent-runtime-'))
const data = path.join(root, 'data'), work = path.join(root, 'work'), evidence = process.env.BLINKY_AGENT_EVIDENCE ?? path.join(root, 'evidence')
for (const dir of [data, work, evidence, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(dir, { recursive: true })
const trace = path.join(root, 'protocol.jsonl'), control = path.join(root, 'control.json'), fake = path.join(root, 'fixture-codex.cjs')
await fs.writeFile(control, '{}')
await fs.writeFile(fake, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const trace=${JSON.stringify(trace)},control=${JSON.stringify(control)};
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let n=0,t=0;const active=new Map();
if(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}
if(process.argv[2]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
function finish(thread,status){const value=active.get(thread);if(!value)return;active.delete(thread);clearInterval(value.timer);const text='Synthetic '+value.tag+' '+status;send({method:'item/started',params:{threadId:thread,item:{id:'final-'+value.turn,type:'agentMessage',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'final-'+value.turn,delta:text}});send({method:'turn/completed',params:{threadId:thread,turn:{id:value.turn,status,...(status==='failed'?{error:{message:'Synthetic executor failure'}}:{})}}})}
readline.createInterface({input:process.stdin}).on('line',line=>{let r;try{r=JSON.parse(line)}catch{return}const p=r.params||{};
if(r.method==='initialize')send({id:r.id,result:{}});
else if(r.method==='model/list')send({id:r.id,result:{data:['fixture-agent','fixture-lead'].map(model=>({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'}]})),nextCursor:null}});
else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:p.threadId||'thread-'+process.pid+'-'+(++n)},approvalPolicy:p.approvalPolicy||'never',approvalsReviewer:p.approvalsReviewer||'user',sandbox:{type:p.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false}}});
else if(r.method==='turn/start'){const thread=p.threadId,turn='turn-'+process.pid+'-'+(++t),text=JSON.stringify(p.input||[]),tag=(text.match(/AGENT_UI_[A-F]/)||['LEAD'])[0];fs.appendFileSync(trace,JSON.stringify({method:r.method,model:p.model,effort:p.effort,thread,tag})+'\\n');send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
const entry={turn,tag};active.set(thread,entry);
if(p.model!=='fixture-agent'){setTimeout(()=>finish(thread,'completed'),100);return}
send({method:'item/started',params:{threadId:thread,item:{id:'command-'+turn,type:'commandExecution',command:'printf synthetic-'+tag,cwd:${JSON.stringify(work)},status:'inProgress'}}});
send({method:'item/started',params:{threadId:thread,item:{id:'answer-'+turn,type:'agentMessage',phase:'partial_answer',text:''}}});send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+turn,delta:'**Increment one '+tag+'**'}});
setTimeout(()=>{if(!active.has(thread))return;send({method:'item/completed',params:{threadId:thread,item:{id:'command-'+turn,type:'commandExecution',command:'printf synthetic-'+tag,aggregatedOutput:'synthetic command output',exitCode:0,status:'completed'}}});send({method:'item/completed',params:{threadId:thread,item:{id:'diff-'+turn,type:'fileChange',status:'completed',changes:[{path:'synthetic.ts',diff:'@@ -1 +1 @@\\n-before\\n+after'}]}}});send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+turn,delta:' / increment two'}})},500);
entry.timer=setInterval(()=>{try{const c=JSON.parse(fs.readFileSync(control));if(c[tag])finish(thread,c[tag])}catch{}},100);
}else if(r.method==='turn/interrupt'){fs.appendFileSync(trace,JSON.stringify({method:r.method,thread:p.threadId})+'\\n');send({id:r.id,result:{}});finish(p.threadId,'interrupted')}
else if(r.id)send({id:r.id,result:{}})
});
`)
await fs.chmod(fake, 0o700)
const backends = Object.fromEntries(['codex', 'claude', 'claude-code', 'kimi', 'grok', 'pi', 'droid', 'opencode', 'openai', 'anthropic', 'openrouter', 'xai'].map(id => [id, { enabled: id === 'codex', command: fake, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'fixture-lead', memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false, backends }))
const bot = { id: 'fixture-bot', name: 'Fixture Bot', emoji: '🧪', color: '#8a8a8a', description: 'Synthetic isolated verification', systemPrompt: 'Only reply with the synthetic fixture response.', backendId: 'codex', modelId: 'fixture-lead', thinking: 'low', executionAgent: { backendId: 'codex', modelId: 'fixture-agent', thinking: 'low' }, tools: ['delegate_task'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'fixture-home', createdAt: 1, updatedAt: 1 }
await fs.writeFile(path.join(data, 'bots', 'fixture-bot.json'), JSON.stringify(bot))
const msg = (id, role, content, extra = {}) => ({ id, role, content, createdAt: 1, ...extra })
const session = (id, messages, archived = true) => ({ id, title: id, cwd: work, mode: 'agent', botIds: [bot.id], activeBotId: bot.id, messages, todos: [], archived, createdAt: 1, updatedAt: 1 })
const home = session('fixture-home', Array.from({ length: 45 }, (_, i) => msg('home-' + i, i % 2 ? 'assistant' : 'user', ('Synthetic main message ' + i + '\n').repeat(4))), false)
await fs.writeFile(path.join(data, 'sessions', home.id + '.json'), JSON.stringify(home))
for (const status of ['completed', 'failed', 'cancelled']) {
  const id = 'saved-' + status, sid = 'session-' + status
  const messages = [msg('request-' + status, 'user', 'Synthetic saved request'), msg('result-' + status, 'assistant', '# Saved ' + status + '\n\n- readable Markdown\n- synthetic data only'), msg('private', 'system', 'PRIVATE SYSTEM SENTINEL'), msg('internal', 'assistant', 'PRIVATE INTERNAL SENTINEL', { internal: true })]
  if (status === 'failed') messages[1].agentTrace = [{ id: 'unfinished', kind: 'commandExecution', phase: 'started', detail: '{"command":"synthetic-unfinished"}' }]
  await fs.writeFile(path.join(data, 'sessions', sid + '.json'), JSON.stringify(session(sid, messages)))
  await fs.writeFile(path.join(data, 'tasks', id + '.json'), JSON.stringify({ id, botId: bot.id, title: 'Saved ' + status, prompt: 'Synthetic request', status, sessionId: sid, createdAt: 1, updatedAt: 1, ...(status === 'failed' ? { error: 'Synthetic saved failure' } : {}) }))
}
for (const [id,sid,empty] of [['read-error','../invalid',false],['missing','no-such-fixture-session',false],['empty','empty-fixture-session',true]]) {
  if(empty) await fs.writeFile(path.join(data,'sessions',sid+'.json'),JSON.stringify(session(sid,[])))
  await fs.writeFile(path.join(data,'tasks','saved-'+id+'.json'),JSON.stringify({id:'saved-'+id,botId:bot.id,title:'Saved '+id,prompt:'Synthetic '+id,status:'completed',sessionId:sid,createdAt:1,updatedAt:1}))
}
if (process.env.BLINKY_AGENT_CORRUPT_TASK === '1') await fs.writeFile(path.join(data, 'tasks', 'corrupt.json'), '{invalid synthetic fixture')
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const port = await freePort(), mainPort = await freePort()
const executable = process.env.BLINKY_AGENT_EXECUTABLE ?? path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let asar, asarSha256
if (process.env.EXPECTED_ASAR_SHA) {
  assert.ok(executable.startsWith('/Volumes/'), 'ASAR-bound verification must use the mounted Preview')
  asar = path.join(executable.slice(0, executable.indexOf('.app/') + 4), 'Contents/Resources/app.asar')
  asarSha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
  assert.equal(asarSha256, process.env.EXPECTED_ASAR_SHA)
  assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).blinkyBuildChannel, 'preview')
}
const args = process.env.BLINKY_AGENT_EXECUTABLE ? [] : [process.env.BLINKY_AGENT_APP_ROOT ?? repo]
args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--inspect=127.0.0.1:' + mainPort, '--user-data-dir=' + path.join(root, 'chromium'))
const env = await connectionTestEnvironment(root)
Object.assign(env, { KIMI_CODE_HOME: path.join(root, 'home', '.kimi-code'), GROK_HOME: path.join(root, 'home', '.grok'), PI_CODING_AGENT_DIR: path.join(root, 'home', '.pi', 'agent') })
Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' })
const app = spawn(executable, args, { cwd: process.env.BLINKY_AGENT_APP_ROOT ?? repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', sockets = [], rendererErrors = [], result = { root, evidence, executable, asarSha256, pid: app.pid, realElectron: true, realAccount: false, codexProtocolFixture: true }
app.stdout.on('data', value => { logs += value }); app.stderr.on('data', value => { logs += value })
async function connect(debugPort, type) {
  let target
  for (let i = 0; i < 250; i++) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Electron exited: ' + app.exitCode + '/' + app.signalCode + '\n' + logs.slice(-2400))
    try { const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json(); target = list.find(value => !type || value.type === type); if (target) break } catch {}
    await delay(100)
  }
  if (!target) throw new Error('No debugger target; ' + logs.slice(-1200))
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0; const pending = new Map()
  ws.onmessage = event => { const value = JSON.parse(event.data); if (value.method === 'Runtime.exceptionThrown') rendererErrors.push(value.params.exceptionDetails.text); if (!value.id) return; const item = pending.get(value.id); if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger timeout: ' + method)) }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => { const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value }
  return { send, evaluate }
}
let ui, main
const wait = async (expression, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await ui.evaluate(expression); if (value) return value; await delay(100) } throw new Error('Timed out: ' + expression + '\n' + logs.slice(-1700)) }
const key = async value => { const code=({Escape:27,Enter:13,Home:36,Tab:9})[value];await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code,...(value==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) }); await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value,windowsVirtualKeyCode:code }); await delay(120) }
const click = async selector => { const point = await ui.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b)throw Error('Missing click target');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); await delay(120) }
const snapshot = async name => { const shot = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64')) }
const run = (command, args) => new Promise(resolve => { const child = spawn(command,args,{stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill('SIGTERM');resolve({code:-1,output:'Isolated capture helper timed out'})},15000);child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);child.on('error',error=>{clearTimeout(timer);resolve({code:-1,output:error.message})});child.on('exit',code=>{clearTimeout(timer);resolve({code,output})}) })
const traceEntries = async () => { try { return (await fs.readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
try {
  ui = await connect(port, 'page'); main = await connect(mainPort)
  await ui.send('Runtime.enable')
  await main.evaluate(`globalThis.__fixtureElectron = process.getBuiltinModule('module').createRequire(process.execPath)('electron')`)
  result.runtime = await main.evaluate(`({electron:process.versions.electron,node:process.versions.node,appPath:__fixtureElectron.app.getAppPath(),userData:__fixtureElectron.app.getPath('userData'),home:process.getBuiltinModule('os').homedir(),shell:process.env.SHELL,configRoots:Object.fromEntries(['XDG_CONFIG_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','KIMI_CODE_HOME','GROK_HOME','PI_CODING_AGENT_DIR'].map(key=>[key,process.env[key]])),bounds:__fixtureElectron.BrowserWindow.getAllWindows()[0].getBounds(),trafficLightPosition:__fixtureElectron.BrowserWindow.getAllWindows()[0].getWindowButtonPosition()})`)
  assert.equal(result.runtime.userData, data)
  assert.equal(result.runtime.home, env.HOME); assert.equal(result.runtime.shell, env.SHELL)
  for (const [key, value] of Object.entries(result.runtime.configRoots)) assert.equal(value, env[key])
  if (asar) assert.equal(result.runtime.appPath, asar)
  await wait(`!!document.querySelector('#ob-prompt')`)
  await click('.ob-header-bot-trigger')
  await wait(`!!document.querySelector('[role=tab][aria-selected=true]')`)
  if (process.env.BLINKY_AGENT_CORRUPT_TASK === '1') {
    await wait(`document.querySelector('.ob-agent-list-error')?.textContent.includes('无法刷新')`)
    assert.equal(await ui.evaluate(`document.querySelector('[role=tabpanel]').textContent.includes('暂无进行中的任务')`), false)
    result.corruptTaskReadVisible = true; await snapshot('corrupt-task-error')
  } else {
    assert.match(await ui.evaluate(`document.querySelector('#ob-bot-details [role=tab][aria-selected=true]').textContent`), /进行中/)
    await wait(`document.querySelector('[role=tabpanel]')?.textContent.includes('暂无进行中的任务')`)
    await click('#ob-bot-details [role=tab]:nth-child(2)')
    for (const status of ['failed', 'cancelled', 'completed']) {
      await click('[data-agent-task-id="saved-' + status + '"]')
      await wait(`!!document.querySelector('main .ob-agent-session-view .ob-agent-transcript .ob-msg')`)
      assert.equal(await ui.evaluate(`!!document.querySelector('#ob-bot-details .ob-agent-transcript')`), false)
      assert.equal(await ui.evaluate(`document.querySelector('.ob-agent-session-view').textContent.includes('PRIVATE')`), false)
      if (status === 'failed') {
        assert.match(await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').textContent`), /1 结果未记录/)
        assert.equal(await ui.evaluate(`!!document.querySelector('.ob-agent-thinking-body')`), false)
        await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').focus()`)
        await key('Enter')
        await wait(`!!document.querySelector('.ob-agent-thinking-body .ob-agent-tool-unknown')`)
        assert.equal(await ui.evaluate(`!!document.querySelector('.ob-agent-session-view .ob-tool-running')`), false)
      }
      await snapshot('saved-' + status)
      await key('Escape'); await wait(`!document.querySelector('.ob-agent-session-view')`)
      assert.ok(await ui.evaluate(`!!document.querySelector('#ob-bot-details')`))
      assert.equal(await ui.evaluate(`document.activeElement?.dataset.agentTaskId`), 'saved-' + status)
    }
    result.terminalStates = ['failed', 'cancelled', 'completed']; result.defaultActive = true
    await main.evaluate(`__fixtureElectron.BrowserWindow.getAllWindows()[0].focus()`)
    await ui.evaluate(`document.querySelector('[data-agent-task-id="saved-completed"]').focus();window.__fixtureKeys=[];document.addEventListener('keydown',event=>__fixtureKeys.push({key:event.key,target:event.target.dataset.agentTaskId,trusted:event.isTrusted}),true)`)
    await key('Enter')
    await wait(`!!document.querySelector('.ob-agent-session-view')`)
    await ui.send('Input.dispatchKeyEvent',{type:'keyDown',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:4})
    await ui.send('Input.dispatchKeyEvent',{type:'keyUp',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:4})
    await wait(`!!document.querySelector('[role=dialog]')`)
    await key('Escape');await wait(`!document.querySelector('[role=dialog]')`)
    assert.ok(await ui.evaluate(`!!document.querySelector('.ob-agent-session-view')`))
    await key('Escape');await wait(`!document.querySelector('.ob-agent-session-view')`)
    result.keyboardReturn=await ui.evaluate(`({id:document.activeElement.dataset.agentTaskId,visible:document.activeElement.matches(':focus-visible'),details:!!document.querySelector('#ob-bot-details')})`)
    assert.deepEqual(result.keyboardReturn,{id:'saved-completed',visible:true,details:true})
    result.layeredEscape=true
    if(process.env.BLINKY_AGENT_EXPECT_READ_REJECTION==='1') {
      for(const [id,text] of [['read-error','无法刷新执行会话'],['missing','当前未读取到执行会话'],['empty','暂时没有可展示的执行消息']]) {
        await click('[data-agent-task-id="saved-'+id+'"]')
        await wait(`document.querySelector('.ob-agent-session-view')?.textContent.includes(${JSON.stringify(text)})`)
        await snapshot('read-'+id)
        await key('Escape')
      }
      result.distinctReadStates=['error','missing','empty']
    }
    await click('#ob-bot-details [role=tab]:first-child')
    const created = []
    for (const tag of ['A', 'B', 'C', 'D', 'E', 'F']) created.push(await ui.evaluate(`window.openbot.tasks.create('fixture-bot','Synthetic isolated AGENT_UI_${tag}','Runtime ${tag}')`))
    assert.ok(created.every(Boolean))
    await wait(`window.openbot.tasks.list().then(ts=>ts.filter(t=>t.status==='running').length===4&&ts.filter(t=>t.status==='queued').length===2)`,60000)
    result.concurrency = { running: 4, queued: 2 }
    await ui.evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'SYNTHETIC UNSENT DRAFT');e.dispatchEvent(new Event('input',{bubbles:true}));const s=document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller');s.scrollTop=73;window.__originalScroll=s.scrollTop;window.__originalDraft=e;window.__originalScroller=s})()`)
    const a = created[0]
    await click('[data-agent-task-id="' + a.id + '"]')
    await wait(`document.querySelector('.ob-agent-session-view')?.textContent.includes('increment two')`,60000)
    assert.ok(await ui.evaluate(`!!document.querySelector('.ob-agent-session-view .ob-md strong')`))
    assert.equal(await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').getAttribute('aria-expanded')`), 'false')
    assert.equal(await ui.evaluate(`!!document.querySelector('.ob-agent-thinking-tools')`), false)
    await snapshot('running-thinking-collapsed')
    await ui.evaluate(`document.querySelector('.ob-agent-thinking-toggle').focus()`)
    await key('Enter')
    await wait(`!!document.querySelector('.ob-agent-thinking-body .ob-tool-ok')`)
    assert.ok(await ui.evaluate(`(()=>{const b=document.querySelector('.ob-agent-thinking-toggle'),section=document.getElementById(b.getAttribute('aria-controls'));return section.getAttribute('aria-labelledby')===b.id&&!document.querySelector('.ob-msg-answer').closest('.ob-agent-thinking')})()`))
    assert.ok(await ui.evaluate(`!!document.querySelector('.ob-agent-session-view .ob-tool-ok')`))
    await ui.evaluate(`Array.from(document.querySelectorAll('.ob-agent-session-view .ob-tool-row')).find(b=>b.textContent.includes('edit_file')).click()`)
    await wait(`!!document.querySelector('.ob-agent-session-view .ob-diff')`)
    await snapshot('running-session')
    const interrupts = (await traceEntries()).filter(entry => entry.method === 'turn/interrupt').length
    await key('Escape'); await wait(`!document.querySelector('.ob-agent-session-view')`)
    assert.deepEqual(await ui.evaluate(`({same:document.querySelector('#ob-prompt')===__originalDraft,value:document.querySelector('#ob-prompt').value,scrollSame:document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller')===__originalScroller,scroll:__originalScroller.scrollTop,expected:__originalScroll,focus:document.activeElement.dataset.agentTaskId})`), { same: true, value: 'SYNTHETIC UNSENT DRAFT', scrollSame: true, scroll: 73, expected: 73, focus: a.id })
    assert.equal((await traceEntries()).filter(entry => entry.method === 'turn/interrupt').length, interrupts)
    assert.equal((await ui.evaluate(`window.openbot.tasks.list()`)).find(task => task.id === a.id).status, 'running')
    result.safeReturn = true; result.realIncrementalUi = true; result.thinkingToolHierarchy = true; result.thinkingKeyboardDisclosure = true
    await ui.evaluate(`window.openbot.tasks.cancel(${JSON.stringify(created[5].id)})`)
    await fs.writeFile(control, JSON.stringify({ AGENT_UI_A: 'completed', AGENT_UI_B: 'failed' }))
    await wait(`window.openbot.tasks.list().then(ts=>ts.some(t=>t.id===${JSON.stringify(a.id)}&&t.status==='completed')&&ts.some(t=>t.id===${JSON.stringify(created[1].id)}&&t.status==='failed')&&ts.some(t=>t.id===${JSON.stringify(created[5].id)}&&t.status==='cancelled'))`,60000)
    await click('#ob-bot-details [role=tab]:nth-child(2)')
    await click('[data-agent-task-id="' + created[1].id + '"]')
    await wait(`document.querySelector('[data-agent-session-status]')?.textContent.includes('失败')`)
    await snapshot('runtime-failure')
    await key('Escape')
    for (const task of await ui.evaluate(`window.openbot.tasks.list()`)) if (['queued','running'].includes(task.status)) await ui.evaluate(`window.openbot.tasks.cancel(${JSON.stringify(task.id)})`)
    await wait(`window.openbot.tasks.list().then(ts=>ts.every(t=>!['running','queued'].includes(t.status)))`)
    await key('Escape'); await wait(`!document.querySelector('#ob-bot-details')`)
    result.realStatusTransitions = true
    // Real backend validation rejection: invalid id must not resolve null/[]
    result.readRejects = await ui.evaluate(`Promise.all([window.openbot.sessions.get('../invalid'),window.openbot.agent.liveMessages('../invalid')].map(p=>p.then(()=>false,()=>true)))`)
    if (process.env.BLINKY_AGENT_EXPECT_READ_REJECTION === '1') assert.deepEqual(result.readRejects,[true,true])
    await click('.ob-header-bot-trigger')
    await snapshot('returned-main')
    await ui.evaluate(`document.querySelector('.ob-sidebar [role=separator]').focus()`)
    await key('Home')
    const sidebar = await ui.evaluate(`document.querySelector('.ob-sidebar').getBoundingClientRect().width`)
    assert.equal(sidebar,100)
    await main.evaluate(`__fixtureElectron.BrowserWindow.getAllWindows()[0].setSize(900,700);__fixtureElectron.BrowserWindow.getAllWindows()[0].focus()`)
    await delay(150)
    result.nativeCompactWindow = await main.evaluate(`({bounds:__fixtureElectron.BrowserWindow.getAllWindows()[0].getBounds(),buttons:__fixtureElectron.BrowserWindow.getAllWindows()[0].getWindowButtonPosition()})`)
    result.nativeCompactWindow.sidebar=sidebar
    await snapshot('compact-window-content')
    await ui.evaluate(`window.openbot.settings.update({theme:'dark'})`)
    await wait(`document.documentElement.dataset.theme==='dark'`)
    result.darkBackground=await ui.evaluate(`getComputedStyle(document.querySelector('.ob-main')).backgroundColor`)
    await snapshot('dark-compact-window-content')
    if (process.env.BLINKY_NATIVE_WINDOW_HELPER) {
      const info=await run(process.env.BLINKY_NATIVE_WINDOW_HELPER,[String(app.pid)])
      if(info.code===0){
        const own=JSON.parse(info.output); result.nativeWindowCapture={window:own}
        const capture=await run('/usr/sbin/screencapture',['-x','-l',String(own.id),path.join(evidence,'native-compact-window.png')])
        result.nativeWindowCapture.code=capture.code
        if(capture.code!==0) result.nativeWindowCapture.error=capture.output.trim()
      }else result.nativeWindowCapture={error:info.output.trim(),code:info.code}
    }
    if(process.env.BLINKY_NATIVE_CAPTURE_HELPER) {
      const capture=await run(process.env.BLINKY_NATIVE_CAPTURE_HELPER,[String(app.pid),path.join(evidence,'native-window-sck.png')])
      result.screenCaptureKit={code:capture.code,detail:capture.output.trim()}
    }
  }
  result.rendererErrors = rendererErrors
  assert.deepEqual(rendererErrors, [])
  result.ok = true
} catch (error) {
  result.ok = false; result.failure = error.stack
  if (ui) await snapshot('failure').catch(() => {})
  throw error
} finally {
  await fs.writeFile(path.join(evidence, 'electron.log'), logs)
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  if (main) await main.evaluate(`__fixtureElectron.app.quit()`).catch(() => {})
  for (const socket of sockets) socket.close()
  for (let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++) await delay(100)
  if (app.exitCode===null&&app.signalCode===null) app.kill('SIGTERM')
  for (let i=0;i<20&&app.exitCode===null&&app.signalCode===null;i++) await delay(100)
  if (app.exitCode===null&&app.signalCode===null) { app.kill('SIGKILL'); for(let i=0;i<20&&app.exitCode===null&&app.signalCode===null;i++)await delay(100) }
  result.processExit={pid:app.pid,exitCode:app.exitCode,signal:app.signalCode,exited:app.exitCode!==null||app.signalCode!==null}
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
