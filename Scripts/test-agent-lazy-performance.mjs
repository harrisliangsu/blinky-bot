// Real isolated Electron + real storage/IPC/UI. Only live model output is a
// deterministic local fixture. Never reads an installed application's data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const repo = path.resolve(process.env.BLINKY_PERF_APP_ROOT ?? path.join(import.meta.dirname, '..'))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-lazy-electron-'))
const output = process.env.BLINKY_PERF_OUTPUT ?? path.join(root, 'result.json')
const data = path.join(root, 'data')
await fs.mkdir(path.join(data, 'bots'), { recursive: true }); await fs.mkdir(path.join(data, 'tasks'))
const backends = Object.fromEntries(['codex','claude','claude-code','kimi','grok','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id => [id, { enabled: false }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ language:'zh-CN', theme:'light', backends, memoryExtraction:'off', notifications:false, runRoutinesWhenClosed:false }))
await fs.writeFile(path.join(data, 'bots', 'perf-bot.json'), JSON.stringify({ id:'perf-bot',name:'Synthetic performance Bot',emoji:'B',color:'#888888',systemPrompt:'Synthetic only',backendId:'codex',modelId:'synthetic',tools:[],computerUse:false,computerTarget:{kind:'local'},activeConversationId:'perf-home',createdAt:1,updatedAt:1 }))
const db = new DatabaseSync(path.join(data, 'sessions.sqlite'))
db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,metadata TEXT NOT NULL); CREATE TABLE messages(session_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_id,id)); CREATE INDEX message_order ON messages(session_id,position); CREATE TABLE blobs(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE imported(id TEXT PRIMARY KEY); BEGIN')
const meta = db.prepare('INSERT INTO sessions VALUES(?,?)'), row = db.prepare('INSERT INTO messages VALUES(?,?,?,?)')
let messageTotal=0, messageBytes=0
for(let i=-1;i<100;i++) {
  const id=i<0?'perf-home':`perf-session-${i}`, count=i<0?45:i===0?1200:120
  meta.run(id,JSON.stringify({id,title:id,cwd:root,mode:'agent',botIds:['perf-bot'],activeBotId:'perf-bot',todos:[],archived:i>=0,createdAt:1,updatedAt:1}))
  for(let n=0;n<count;n++) {
    const value=JSON.stringify({id:`message-${i}-${n}`,role:n%2?'assistant':'user',content:`## Synthetic message ${n}\n\n`+'Readable synthetic **Markdown**, code `value`, and sample detail. '.repeat(24),createdAt:1,...(n%2?{agentTrace:[{id:`cmd-${n}`,kind:'commandExecution',phase:'completed',detail:JSON.stringify({command:'synthetic command',exitCode:0,aggregatedOutput:'synthetic output'})}]}:{})})
    row.run(id,`message-${i}-${n}`,n,value);messageTotal++;messageBytes+=Buffer.byteLength(value)
  }
  if(i>=0) await fs.writeFile(path.join(data,'tasks',`perf-task-${i}.json`),JSON.stringify({id:`perf-task-${i}`,title:`Synthetic task ${i}`,botId:'perf-bot',sessionId:id,status:'completed',prompt:'Synthetic request. '.repeat(4500),result:'Synthetic result. '.repeat(1500),createdAt:1000-i,updatedAt:1000-i}))
}
db.exec('COMMIT');db.close()
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const uiPort=await port(), mainPort=await port()
const executable=process.env.BLINKY_PERF_EXECUTABLE ?? path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const args=process.env.BLINKY_PERF_EXECUTABLE?[]:[repo]
args.push(`--inspect=127.0.0.1:${mainPort}`,`--remote-debugging-port=${uiPort}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${path.join(root,'chromium')}`)
const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','SHELL','TMPDIR','__CF_USER_TEXT_ENCODING'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(env,{OPENBOT_DATA_DIR:data,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'})
const started=performance.now(), child=spawn(executable,args,{cwd:repo,env,stdio:['ignore','pipe','pipe']})
let logs='',seq=0;const sockets=[],errors=[]
child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x)
async function connect(port,type) {
  let target
  for(let i=0;i<300;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x=>!type||x.type===type);if(target)break}catch{}if(child.exitCode!==null)throw Error('Electron exited '+logs.slice(-1000));await delay(100)}
  if(!target)throw Error('No debugger target '+logs.slice(-1000))
  const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});const pending=new Map()
  ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.method==='Runtime.exceptionThrown')errors.push(x.params.exceptionDetails.text);const p=pending.get(x.id);if(p){pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Error(JSON.stringify(x.error))):p.resolve(x.result)}}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const x=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw Error(JSON.stringify(x.exceptionDetails));return x.result.value}
  return {send,evaluate}
}
let ui,main;const result={root,repo,executable,synthetic:true,realElectron:true,realModel:false,sample:{tasks:100,messages:messageTotal,messageBytes,longConversation:1200}}
const wait=async expression=>{for(let i=0;i<400;i++){if(await ui.evaluate(expression))return;await delay(50)}throw Error('Timeout '+expression)}
const click=async selector=>{await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus({preventScroll:true});e.click()})()`);await delay(20)}
try {
  ui=await connect(uiPort,'page');main=await connect(mainPort);await ui.send('Runtime.enable');await wait('Boolean(document.querySelector("#ob-prompt"))')
  result.startupMs=Math.round(performance.now()-started)
  result.runtime=await main.evaluate(`(()=>{globalThis.__perfElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return{pid:process.pid,appPath:__perfElectron.app.getAppPath(),userData:__perfElectron.app.getPath('userData'),electron:process.versions.electron,rss:process.memoryUsage().rss}})()`)
  assert.equal(result.runtime.userData,data)
  await main.evaluate(`(()=>{globalThis.__perfCounts={saved:0,live:0,savedBytes:0,liveBytes:0,taskReads:0,ids:[]};globalThis.__perfFinal=false;globalThis.__perfLive=[];const h=__perfElectron.ipcMain._invokeHandlers;for(const name of ['openbot:sessions:get','openbot:agent:live-messages','openbot:agent:liveMessages','openbot:tasks:get']){if(!h.has(name))continue;const original=h.get(name);h.set(name,async(...args)=>{let value=await original(...args);const id=args[1];if(name==='openbot:tasks:get')__perfCounts.taskReads++;else if(name==='openbot:sessions:get'){__perfCounts.ids.push(id);if(id==='perf-session-0'&&__perfFinal)value={...value,messages:[...value.messages,{id:'fixture-live',role:'assistant',content:'SYNTHETIC FINAL',createdAt:1}]};__perfCounts.saved++;__perfCounts.savedBytes+=JSON.stringify(value).length}else{if(id==='perf-session-0')value=__perfLive;__perfCounts.live++;__perfCounts.liveBytes+=JSON.stringify(value).length}return value})}return [...h.keys()].filter(k=>k.includes('live'))})()`)
  await ui.evaluate(`window.__perfEvents=[];window.__perfOff=window.openbot.on(e=>{if(e.type==='session-updated'||e.type==='session-summary-updated')__perfEvents.push({type:e.type,bytes:JSON.stringify(e).length})});window.__longTasks=[];new PerformanceObserver(l=>__longTasks.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true})`)
  const list=await ui.evaluate(`(async()=>{const t=performance.now();const rows=await(window.openbot.tasks.summaries?window.openbot.tasks.summaries('perf-bot'):window.openbot.tasks.list());return{ms:performance.now()-t,bytes:JSON.stringify(rows).length,count:rows.length,hasPrompt:rows.some(t=>'prompt'in t)}})()`)
  result.taskList=list
  await ui.evaluate(`window.openbot.sessions.rename('perf-session-0','Synthetic renamed session')`)
  await delay(100)
  result.unopenedBroadcast=await ui.evaluate('__perfEvents.splice(0)')
  const t=performance.now();await click('.ob-header-bot-trigger');await wait('Boolean(document.querySelector("#ob-bot-details [role=tab]"))');await click('#ob-bot-details [role=tab]:nth-child(2)');await wait('Boolean(document.querySelector("[data-agent-task-id=perf-task-0]"))')
  result.openListMs=Math.round(performance.now()-t);result.listRows=await ui.evaluate('document.querySelectorAll("[data-agent-task-id]").length')
  result.beforeClick=await main.evaluate('__perfCounts')
  assert.equal(result.beforeClick.saved,0,'Opening task list must not read any execution transcript')
  assert.equal(result.beforeClick.taskReads,0,'Opening task list must not read task bodies')
  await ui.evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'SYNTHETIC UNSENT');e.dispatchEvent(new Event('input',{bubbles:true}));window.__draft=e;window.__mainScroll=document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller');__mainScroll.scrollTop=73})()`)
  await main.evaluate('__perfElectron.BrowserWindow.getAllWindows()[0].focus()')
  const opened=performance.now();await click('[data-agent-task-id=perf-task-0]');await wait('Boolean(document.querySelector(".ob-agent-transcript .ob-msg"))')
  result.openConversationMs=Math.round(performance.now()-opened);result.conversationRows=await ui.evaluate('document.querySelectorAll(".ob-agent-transcript .ob-msg").length')
  if(process.env.BLINKY_PERF_EXPECT_LAZY==='1') {
    assert.equal(list.hasPrompt,false);assert.ok(list.bytes<100000);assert.ok(result.listRows<=50);assert.ok(result.conversationRows<=60)
    assert.equal(result.unopenedBroadcast.at(-1).type,'session-summary-updated')
    await ui.evaluate(`(()=>{const s=document.querySelector('.ob-agent-transcript .ob-transcript-scroller');s.scrollTop=100;s.dispatchEvent(new Event('scroll'));window.__anchor={top:s.scrollTop,height:s.scrollHeight}})()`)
    await click('.ob-agent-earlier');await delay(150)
    result.earlierAnchor=await ui.evaluate(`(()=>{const s=document.querySelector('.ob-agent-transcript .ob-transcript-scroller');return{before:__anchor.top,after:s.scrollTop,growth:s.scrollHeight-__anchor.height,rows:document.querySelectorAll('.ob-agent-transcript .ob-msg').length}})()`)
    assert.equal(result.earlierAnchor.rows,120);assert.ok(Math.abs(result.earlierAnchor.after-result.earlierAnchor.before-result.earlierAnchor.growth)<3)
  }
  await ui.evaluate(`window.openbot.sessions.rename('perf-session-0','Synthetic watched session')`);await delay(150)
  result.openedBroadcast=await ui.evaluate('__perfEvents.splice(0)')
  assert.ok(result.openedBroadcast.some(e=>e.type==='session-updated'))
  result.beforeStream=await main.evaluate('__perfCounts')
  await main.evaluate(`(()=>{__perfLive=[{id:'fixture-live',role:'assistant',content:'',segments:[{id:'synthetic-public',phase:'partial_answer',text:''}],streaming:true,createdAt:1}];const w=__perfElectron.BrowserWindow.getAllWindows()[0].webContents;w.send('openbot:event',{type:'message-start',sessionId:'perf-session-0',message:__perfLive[0]});let n=0;globalThis.__perfTimer=setInterval(()=>{__perfLive[0].content+='SYNTHETIC TOKEN ';__perfLive[0].segments[0].text=__perfLive[0].content;w.send('openbot:event',{type:'text-delta',sessionId:'perf-session-0',messageId:'fixture-live',delta:'SYNTHETIC TOKEN ',segment:{id:'synthetic-public',phase:'partial_answer',delta:'SYNTHETIC TOKEN '}});if(++n===120)clearInterval(__perfTimer)},15)})()`)
  await delay(2300)
  await wait(`document.querySelector('.ob-agent-session-view').textContent.includes('SYNTHETIC TOKEN')`)
  result.afterStream=await main.evaluate('__perfCounts')
  result.stream={savedReads:result.afterStream.saved-result.beforeStream.saved,liveReads:result.afterStream.live-result.beforeStream.live,savedBytes:result.afterStream.savedBytes-result.beforeStream.savedBytes,liveBytes:result.afterStream.liveBytes-result.beforeStream.liveBytes}
  await main.evaluate(`(()=>{__perfFinal=true;__perfLive=[];const w=__perfElectron.BrowserWindow.getAllWindows()[0].webContents;w.send('openbot:event',{type:'message-end',sessionId:'perf-session-0',messageId:'fixture-live',content:'SYNTHETIC FINAL'});w.send('openbot:event',{type:'done',sessionId:'perf-session-0'})})()`)
  await wait(`document.querySelector('.ob-agent-session-view').textContent.includes('SYNTHETIC FINAL')`)
  result.longTasks=await ui.evaluate('({count:__longTasks.length,totalMs:Math.round(__longTasks.reduce((a,b)=>a+b,0)),maxMs:Math.round(Math.max(0,...__longTasks))})')
  await main.evaluate('__perfElectron.BrowserWindow.getAllWindows()[0].focus()')
  await ui.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ui.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector(".ob-agent-session-view")')
  // Return focus is scheduled after unmount on requestAnimationFrame. A
  // background Electron window can defer that frame; observe the actual target
  // instead of treating DOM removal as evidence that focus restoration ended.
  await wait(`document.activeElement?.dataset.agentTaskId==='perf-task-0'`)
  result.return=await ui.evaluate(`({same:document.querySelector('#ob-prompt')===__draft,value:__draft.value,scrollSame:document.querySelector('.ob-agent-main-underlay .ob-transcript-scroller')===__mainScroll,scroll:__mainScroll.scrollTop,focus:document.activeElement.dataset.agentTaskId})`)
  assert.deepEqual(result.return,{same:true,value:'SYNTHETIC UNSENT',scrollSame:true,scroll:73,focus:'perf-task-0'})
  const before=await main.evaluate('__perfCounts.saved');await delay(250);assert.equal(await main.evaluate('__perfCounts.saved'),before)
  await ui.evaluate(`window.openbot.sessions.rename('perf-session-0','Synthetic closed session')`);await delay(100)
  result.closedBroadcast=await ui.evaluate('__perfEvents.splice(0)')
  if(process.env.BLINKY_PERF_EXPECT_LAZY==='1'){assert.equal(result.stream.savedReads,0);assert.ok(result.closedBroadcast.some(e=>e.type==='session-summary-updated'))}
  const image=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'returned.png'),Buffer.from(image.data,'base64'))
  result.errors=errors;assert.deepEqual(errors,[]);result.ok=true
} catch(error){result.ok=false;result.failure=error.stack;throw error}
finally {
  if(main)await main.evaluate('__perfElectron.app.quit()').catch(()=>{})
  for(const ws of sockets)ws.close()
  for(let i=0;i<60&&child.exitCode===null&&child.signalCode===null;i++)await delay(100)
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
  await fs.writeFile(path.join(root,'electron.log'),logs);await fs.writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}
