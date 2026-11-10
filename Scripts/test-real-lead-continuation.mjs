import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'darwin') throw new Error('This Electron test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-grok-batch-'))
const data = path.join(root, 'data')
const binary = path.join(root, 'grok')
const trace = path.join(root, 'trace')
const interrupted = path.join(root, 'interrupted')
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
await fs.writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2)
if(args.includes('--version')) { console.log('grok 1.0.70'); process.exit(0) }
if(args.includes('models')) { console.log('Available models:\\n  * grok-4.6 (default)'); process.exit(0) }
if(args.includes('--prompt-file')) {
 const prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8')
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(prompt)+'\\n')
 const count=fs.readFileSync(${JSON.stringify(trace)},'utf8').trim().split('\\n').length
 if(process.env.BLINKY_TEST_REAL_ACCEPTANCE==='1'){if(count>1)fs.writeFileSync(process.env.BLD_OUTPUT,'fixture output');console.log(JSON.stringify({type:'text',data:count===1?'声称已完成并创建 artifact.txt。':'文件已创建，最终口令 FINISH-4826。'}))}
 else console.log(JSON.stringify({type:'text',data:count===1?'只完成第一部分，第二部分还没有执行，任务尚未完成。请让我继续。':'第二部分也已完成，最终口令是 FINISH-4826。'}))
} else process.exit(0)
`)
await fs.chmod(binary, 0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({language:'zh-CN',defaultBackendId:'codex',defaultModelId:'default',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:process.env.HOME+'/.local/bin/codex'},grok:{enabled:true,added:true,command:binary,defaultModelId:'grok-4.6'}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'Follow the user request.',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'default',followsDefault:false,executionAgent:{backendId:'grok',modelId:'grok-4.6'},tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLD_OUTPUT:path.join(root,'artifact.txt')},stdio:['ignore','pipe','pipe']})
let logs=''; app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws; let seq=0; const pending=new Map()
function cmd(method,params={}) {const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function wait(expression,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw new Error('Timed out: '+expression+' '+logs.slice(-1500))}
try {
 let targets; const end=Date.now()+30000
 while(Date.now()<end){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw new Error('No renderer: '+logs)
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const cb=pending.get(m.id);pending.delete(m.id);m.error?cb.reject(Error(JSON.stringify(m.error))):cb.resolve(m.result)}}
 await wait(`!!document.querySelector('#ob-prompt')`)
 if(process.env.BLINKY_TEST_REAL_ACCEPTANCE==='1')await evaluate(`window.openbot.bots.list().then(bs=>window.openbot.sessions.setCwd(bs.find(b=>b.id==='blinky').activeConversationId,${JSON.stringify(root)}))`)
 const submit=async text=>evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await submit(process.env.BLINKY_TEST_REAL_ACCEPTANCE==='1'?'请用独立执行 Agent 在当前临时工作目录中创建 artifact.txt，拿到最终口令后报告。委派时请用 output_files 登记该文件以便程序检查；你自己不要创建文件。如果文件不存在，请让同一个 Agent 继续。不要访问网络或修改其他文件。':'请用独立执行 Agent 完成一个纯文本两阶段测试：第一阶段结果若表示第二阶段尚未完成，请让同一执行 Agent 继续，直到它返回最终口令，然后在这里告诉我口令。不要访问网络、读写用户文件或运行其他命令。')
 await wait(`(async()=>{const t=await window.openbot.tasks.list();return t.filter(x=>x.sourceSessionId&&x.deliveryStatus==='delivered').length>=2})()`,90000)
 const state=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {tasks:await window.openbot.tasks.list(),messages:s.messages.map(x=>({role:x.role,content:x.content,internal:x.internal}))}})()`)
 const first=state.tasks.find(x=>x.result?.includes(process.env.BLINKY_TEST_REAL_ACCEPTANCE==='1'?'声称已完成':'第一部分'));const next=state.tasks.find(x=>x.result?.includes('FINISH-4826'))
 if(!first||!next||next.continuedFromTaskId!==first.id||next.sessionId!==first.sessionId)throw Error('missing same-session continuation: '+JSON.stringify(state))
 if(!state.messages.some(x=>x.role==='assistant'&&!x.internal&&x.content.includes('FINISH-4826')))throw Error('lead did not report final outcome: '+JSON.stringify(state))
 if(process.env.BLINKY_TEST_REAL_ACCEPTANCE==='1'&&(!first.acceptance||first.review||next.review?.verifiedFiles?.[0]?.path!=='artifact.txt'))throw Error('real lead did not preserve and verify the explicit output condition')
 console.log(JSON.stringify({realLead:'codex',executor:'simulated-grok',automaticContinuation:true,sameSession:true,finalReply:true}))
} catch(error) { const debug=await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=b?.activeConversationId?await window.openbot.sessions.get(b.activeConversationId):null;return {tasks:await window.openbot.tasks.list(),messages:s?.messages,running:b?.activeConversationId?await window.openbot.agent.isRunning(b.activeConversationId):null,body:document.body.innerText.slice(-3000)}})()`).catch(e=>({error:String(e)}));console.error('DIAGNOSTIC',JSON.stringify(debug));throw error } finally {if(ws)ws.close();app.kill('SIGTERM');await delay(400);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
