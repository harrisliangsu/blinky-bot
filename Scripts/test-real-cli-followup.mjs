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
const backend=process.argv[2]||'kimi'
if(!['kimi','grok'].includes(backend))throw new Error('Pass kimi or grok')
let binary=backend==='kimi'?process.env.HOME+'/.kimi-code/bin/kimi':process.env.HOME+'/.local/bin/grok'
const acpTrace=path.join(root,'acp-types')
if(backend==='kimi'&&process.env.BLINKY_TRACE_ACP==='1'){
 const actual=binary;binary=path.join(root,'kimi-proxy')
 await fs.writeFile(binary,`#!${process.execPath}\n`+String.raw`
const {spawn}=require('node:child_process'),readline=require('node:readline'),fs=require('node:fs');const child=spawn(process.env.KIMI_REAL_BINARY,process.argv.slice(2),{stdio:['pipe','pipe','ignore']});readline.createInterface({input:process.stdin}).on('line',line=>child.stdin.write(line+'\n'));readline.createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.method==='session/request_permission')fs.appendFileSync(process.env.KIMI_ACP_TRACE,JSON.stringify({event:'permission',kind:m.params?.toolCall?.kind,title:m.params?.toolCall?.title,content:m.params?.toolCall?.content,keys:Object.keys(m.params?.toolCall||{}),options:(m.params?.options||[]).map(x=>x.kind)})+'\n');else if(m.method==='session/update'&&m.params?.update?.sessionUpdate==='tool_call')fs.appendFileSync(process.env.KIMI_ACP_TRACE,JSON.stringify({event:'tool_call',toolCall:m.params.update})+'\n')}catch{}process.stdout.write(line+'\n')});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code||0))
 `);await fs.chmod(binary,0o700);process.env.KIMI_REAL_BINARY=actual;process.env.KIMI_ACP_TRACE=acpTrace
}
await fs.mkdir(path.join(data,'bots'),{recursive:true})
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({language:'zh-CN',defaultBackendId:backend,defaultModelId:'default',approvalPolicy:'auto-run',backends:{[backend]:{enabled:true,added:true,command:binary},codex:{enabled:true,command:process.env.HOME+'/.local/bin/codex'}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'Follow the user request exactly.',emoji:'✨',color:'#7c9cff',backendId:backend,modelId:'default',followsDefault:true,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
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
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id===${JSON.stringify(backend)}&&x.status==='available'))`,40000)
 const submit=async text=>evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 if(process.env.BLINKY_TEST_NATIVE==='1'){
  const fixture=path.join(root,'fixture.txt');await fs.writeFile(fixture,'before')
  await submit(`请使用文件工具将 ${fixture} 的内容从 before 改成 after，然后报告结果。`)
  await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !!b?.activeConversationId && window.openbot.agent.isRunning(b.activeConversationId)})()`)
  await wait(`!!document.querySelector('.ob-approval') || (async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !await window.openbot.agent.isRunning(b.activeConversationId)})()`,90000)
  const approval=await evaluate(`!!document.querySelector('.ob-approval')`)
  const approvalText=approval?await evaluate(`document.querySelector('.ob-approval').innerText`):''
  if(approval&&!approvalText.includes(fixture))throw Error('Native approval did not show the target path')
  const approve=process.env.BLINKY_APPROVE_TEST==='1'
  if(approval){await delay(600);await evaluate(`[...document.querySelectorAll('.ob-approval button')].find(b=>b.textContent.trim()===${JSON.stringify(approve?'允许':'拒绝')}).click()`);await wait(`!document.querySelector('.ob-approval')`)}
  await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !await window.openbot.agent.isRunning(b.activeConversationId)})()`,90000)
  const changed=(await fs.readFile(fixture,'utf8'))!=='before'
  if(approval&&!approve&&changed)throw Error('Fixture changed after approval was rejected')
  if(approve&&(!approval||!changed))throw Error('An approved native edit did not update the fixture')
  const replies=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s.messages.filter(m=>m.role==='assistant'&&!m.internal).map(m=>m.content)})()`)
  const permissionTypes=await fs.readFile(acpTrace,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(()=>[])
  console.log(JSON.stringify({realElectron:true,realBackend:backend,nativeApprovalRequested:approval,decision:approval?(approve?'allow':'reject'):'none',approvalTargetVisible:approvalText.includes(fixture),approvalText,fixtureChanged:changed,permissionTypes,replies}))
 }else{
 await submit('这是纯文字测试。请详细比较十种水果的口感和季节，不要使用任何工具。')
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !!b?.activeConversationId && window.openbot.agent.isRunning(b.activeConversationId)})()`)
 await delay(400)
 await submit('请把这次最终答复设为：蓝莓和柠檬')
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s?.messages.some(m=>m.internal&&m.content.includes('previous execution was interrupted')) && s.messages.some(m=>m.role==='user'&&m.content.includes('蓝莓和柠檬'))})()`,45000)
 await wait(`document.body.innerText.includes('蓝莓和柠檬') && !!document.querySelector('.ob-msg-assistant')`,45000)
 const result=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {users:s.messages.filter(m=>m.role==='user'&&!m.internal).map(m=>m.content),replies:s.messages.filter(m=>m.role==='assistant'&&!m.internal).map(m=>m.content),shown:Array.from(document.querySelectorAll('.ob-msg-assistant')).map(e=>e.innerText)}})()`)
 if(result.users.filter(x=>x.includes('蓝莓和柠檬')).length!==1||!result.shown.at(-1)?.includes('蓝莓和柠檬'))throw Error('unexpected result: '+JSON.stringify(result))
 console.log(JSON.stringify({realBackend:backend,interruptedAndContinued:true,finalContainsFollowup:true,userMessageOnce:true}))
 }
} catch(error) { const debug=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');if(!b?.activeConversationId)return {body:document.body.innerText.slice(-1800)};const id=b.activeConversationId;const s=await window.openbot.sessions.get(id);return {body:document.body.innerText.slice(-1800),running:await window.openbot.agent.isRunning(id),queue:await window.openbot.agent.queue(id),messages:s?.messages.map(m=>({role:m.role,content:m.content,internal:m.internal,error:m.error,displayContent:m.displayContent}))}})()`).catch(e=>({diagnostic:String(e)}));console.error('DIAGNOSTIC',JSON.stringify(debug));throw error } finally {if(ws)ws.close();app.kill('SIGTERM');await delay(400);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
