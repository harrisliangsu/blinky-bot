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
const fs=require('node:fs'); const args=process.argv.slice(2)
if(args.includes('--version')) { console.log('grok 1.0.70'); process.exit(0) }
if(args.includes('models')) { console.log('Available models:\\n  * grok-4.6 (default)'); process.exit(0) }
if(args.includes('stdio')) {
 const readline=require('node:readline'),send=x=>process.stdout.write(JSON.stringify(x)+'\\n')
 process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(interrupted)},'yes');process.exit(0)})
 readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line)
  if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],agentCapabilities:{mcpCapabilities:{http:true}}}})
  else if(r.method==='authenticate')send({id:r.id,result:{}})
  else if(r.method==='session/new'||r.method==='session/load'){
   fs.writeFileSync(process.env.BLINKY_GROK_POLICY_MARKER,JSON.stringify({event:'session_start',mode:'default',sessionId:'grok-batch'}))
   send({id:r.id,result:{sessionId:'grok-batch'}})
  }
  else if(r.method==='session/set_config_option')send({id:r.id,result:{configOptions:[{id:r.params.configId,currentValue:r.params.value}]}})
  else if(r.method==='session/prompt'){
   const prompt=r.params.prompt.filter(x=>x.type==='text').map(x=>x.text).join('\\n')
   fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(prompt)+'\\n')
   const count=fs.readFileSync(${JSON.stringify(trace)},'utf8').trim().split('\\n').length
   setTimeout(()=>{
    if(count!==1){send({method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'internal-progress'}}}});send({method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:'read',kind:'read',title:'read_file'}}})}
    send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:count===1?'first-answer':'combined-answer'}}}})
    send({id:r.id,result:{stopReason:'end_turn'}})
   },count===1?1800:1200)
  }
 })
} else
if(args.includes('--prompt-file')) {
 process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(interrupted)},'yes');process.exit(0)})
 const prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8')
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(prompt)+'\\n')
 const count=fs.readFileSync(${JSON.stringify(trace)},'utf8').trim().split('\\n').length
 setTimeout(()=>{ if(count===1) console.log(JSON.stringify({type:'text',data:'first-answer'})); else {console.log(JSON.stringify({type:'text',data:'internal-progress'}));console.log(JSON.stringify({type:'tool_call',toolName:'read_file',rawInput:{path:'example'}}));console.log(JSON.stringify({type:'text',data:'combined-answer'}));} },count===1?1800:1200)
} else process.exit(0)
`)
await fs.chmod(binary, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({language:'zh-CN',defaultBackendId:'grok',defaultModelId:'grok-4.6',memoryExtraction:'off',approvalPolicy:'auto-run',backends:{grok:{enabled:true,added:true,command:binary,defaultModelId:'grok-4.6'}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'grok',modelId:'grok-4.6',tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']})
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
 const submit=async text=>evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await submit('initial request')
 await wait(`!!document.querySelector('.ob-header .ob-working')`)
 for(let i=0;i<100;i++){try{await fs.access(trace);break}catch{await delay(30)}}
 await submit('followup alpha')
 await submit('followup beta')
 await wait(`document.body.innerText.includes('combined-answer')`,30000)
 const prompts=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse)
 if(prompts.length!==2||!prompts[1].includes('followup alpha')||!prompts[1].includes('followup beta')) throw new Error('Follow-ups were not combined: '+JSON.stringify(prompts))
 if(!prompts[1].includes('previous execution was interrupted')) throw new Error('Continuation did not receive interruption context')
 await fs.access(interrupted)
 if(await evaluate(`document.body.innerText.includes('first-answer')`)) throw new Error('Interrupted answer was presented as a final reply')
 if(await evaluate(`document.body.innerText.includes('internal-progress') || document.body.innerText.includes('read_file')`)) throw new Error('CLI tool progress leaked into the chat')
 const order=await evaluate(`Array.from(document.querySelectorAll('.ob-msg-user,.ob-msg-assistant')).map(x=>x.innerText)`)
 if(!order.at(-1)?.includes('combined-answer')) throw new Error('Final response did not follow the newest user input: '+JSON.stringify(order))
 console.log(JSON.stringify({backend:'fake-grok',interrupted:true,turns:prompts.length,batchedFollowups:true,finalAfterFollowups:true,toolProgressHidden:true}))
} finally {if(ws)ws.close();app.kill('SIGTERM');await delay(400);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
