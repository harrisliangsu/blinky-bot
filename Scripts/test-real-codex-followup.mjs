import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
if (process.platform !== 'darwin') throw new Error('This Electron test requires macOS.')
const repo=process.cwd()
const root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-real-codex-'))
const data=path.join(root,'data')
await fs.mkdir(path.join(data,'bots'),{recursive:true})
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({language:'zh-CN',defaultBackendId:'codex',defaultModelId:'default',approvalPolicy:'auto-run',backends:{codex:{enabled:true,added:true,command:process.env.HOME+'/.local/bin/codex'}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'Follow the user request exactly.',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'default',followsDefault:true,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']})
let logs=''; app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws; let seq=0; const pending=new Map()
function cmd(method,params={}) {const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function wait(expression,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw new Error('Timed out: '+expression+' '+logs.slice(-1500))}
try {
 let targets;const end=Date.now()+30000
 while(Date.now()<end){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw new Error('No renderer: '+logs.slice(-1500))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const cb=pending.get(m.id);pending.delete(m.id);m.error?cb.reject(Error(JSON.stringify(m.error))):cb.resolve(m.result)}}
 await wait(`!!document.querySelector('#ob-prompt')`)
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex'&&x.status==='available'))`,40000)
 const submit=async text=>evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await submit('先仅执行一次 sleep 4，等命令结束后给我一个简短回答。不要执行其他命令。')
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !!b?.activeConversationId && window.openbot.agent.isRunning(b.activeConversationId)})()`)
 await submit('请把这次最终答复设为：蓝莓和柠檬')
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s?.messages.some(m=>m.role==='user'&&m.content.includes('蓝莓和柠檬')) && await window.openbot.agent.isRunning(b.activeConversationId)})()`,45000)
 await wait(`Array.from(document.querySelectorAll('.ob-msg-assistant')).some(e=>e.innerText.includes('蓝莓和柠檬'))`,90000)
 const result=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {users:s.messages.filter(m=>m.role==='user'&&!m.internal).map(m=>m.content),replies:s.messages.filter(m=>m.role==='assistant'&&!m.internal).map(m=>m.content),shown:Array.from(document.querySelectorAll('.ob-msg-assistant')).map(e=>e.innerText)}})()`)
 if(result.users.filter(x=>x.includes('蓝莓和柠檬')).length!==1||!result.shown.at(-1)?.includes('蓝莓和柠檬'))throw Error('unexpected result: '+JSON.stringify(result))
 console.log(JSON.stringify({realCodex:true,followupRecordedWhileRunning:true,finalContainsFollowup:true,userMessageOnce:true}))
} finally {if(ws)ws.close();app.kill('SIGTERM');await delay(400);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
