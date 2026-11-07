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
 const readline=require('node:readline'), send=x=>process.stdout.write(JSON.stringify(x)+'\\n')
 readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line)
  if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],agentCapabilities:{mcpCapabilities:{http:true}}}})
  else if(r.method==='authenticate')send({id:r.id,result:{}})
  else if(r.method==='session/new'||r.method==='session/load'){
   fs.writeFileSync(process.env.BLINKY_GROK_POLICY_MARKER,JSON.stringify({event:'session_start',mode:'default',sessionId:'grok-memory'}))
   send({id:r.id,result:{sessionId:'grok-memory'}})
  }
  else if(r.method==='session/set_config_option')send({id:r.id,result:{configOptions:[{id:r.params.configId,currentValue:r.params.value}]}})
  else if(r.method==='session/prompt'){
   fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(r.params.prompt)+'\\n')
   send({method:'session/update',params:{sessionId:'grok-memory',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'first-answer'}}}})
   send({id:r.id,result:{stopReason:'end_turn'}})
  }
 })
} else
if(args.includes('--prompt-file')) {
 process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(interrupted)},'yes');process.exit(0)})
 const prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8')
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(prompt)+'\\n')
 const count=fs.readFileSync(${JSON.stringify(trace)},'utf8').trim().split('\\n').length
 setTimeout(()=>{ console.log(JSON.stringify({type:'text',data:count===1?'first-answer':'combined-answer'})); },count===1?1800:20)
} else process.exit(0)
`)
await fs.chmod(binary, 0o700)
const codex = path.join(root, 'codex')
const memoryTrace = path.join(root, 'memory-trace')
await fs.writeFile(codex, `#!/usr/bin/env node
const fs=require('node:fs'), readline=require('node:readline'), args=process.argv.slice(2)
if(args.includes('--version')) {console.log('codex-cli 0.166.0');process.exit(0)}
if(args[0]==='login') {console.log('Logged in using ChatGPT');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n')
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line)
 if(r.method==='initialize')send({id:r.id,result:{}})
 else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'test-memory',displayName:'Test Memory'}],nextCursor:null}})
 else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'memory-thread'}}})
 else if(r.method==='turn/start'){fs.writeFileSync(${JSON.stringify(memoryTrace)},JSON.stringify(r.params.sandboxPolicy));const turn='memory-turn';send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'memory-thread'}});send({method:'item/agentMessage/delta',params:{itemId:'memory-answer',delta:process.env.BLINKY_TEST_INVALID_MEMORY === '1' ? 'invalid extraction output' : JSON.stringify(['用户工作时习惯喝无糖茉莉花茶。'])}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),20)}
})
`)
await fs.chmod(codex,0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({language:'zh-CN',defaultBackendId:'grok',defaultModelId:'grok-4.6',memoryExtraction:'off',approvalPolicy:'auto-run',backends:{grok:{enabled:true,added:true,command:binary,defaultModelId:'grok-4.6'},codex:{enabled:true,command:codex,defaultModelId:'test-memory'}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'grok',modelId:'grok-4.6',tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let logs=''
function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
let app=launch()
let ws; let seq=0; const pending=new Map()
function cmd(method,params={}) {const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function wait(expression,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw new Error('Timed out: '+expression+' '+logs.slice(-1500))}
async function connect() {
 let targets; const end=Date.now()+30000
 while(Date.now()<end){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw new Error('No renderer: '+logs)
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const cb=pending.get(m.id);pending.delete(m.id);m.error?cb.reject(Error(JSON.stringify(m.error))):cb.resolve(m.result)}}
}
try {
 await connect()
 await wait(`!!document.querySelector('#ob-prompt')`)
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex'&&x.status==='available'))`,40000)
 await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'我工作时习惯喝一杯无糖茉莉花茶。');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await wait(`document.body.innerText.includes('first-answer')`,30000)
 if (process.env.BLINKY_TEST_INVALID_MEMORY === '1') {
   await wait(`window.openbot.activity.list().then(entries=>entries.some(e=>e.title==='记忆提取未完成'))`,30000)
   if(await evaluate(`window.openbot.bots.memory('blinky').then(entries=>entries.some(e=>e.text.includes('茉莉花茶'))) `)) throw Error('Invalid extraction was saved as memory')
   console.log(JSON.stringify({invalidExtractionReported:true,invalidExtractionNotSaved:true}))
 } else {
   await wait(`window.openbot.bots.memory('blinky').then(entries=>entries.some(e=>e.text.includes('茉莉花茶')))`,30000)
 }
 const policy=JSON.parse(await fs.readFile(memoryTrace,'utf8'))
 if(policy.type!=='readOnly')throw Error('Memory extractor did not use read-only Codex: '+JSON.stringify(policy))
 const settings=await evaluate(`window.openbot.settings.get().then(s=>s.memoryExtraction)`)
 if(settings!=='all')throw Error('Legacy memory setting was not enabled: '+settings)
 if (process.env.BLINKY_TEST_INVALID_MEMORY !== '1') {
   const old=await evaluate(`window.openbot.bots.memory('blinky').then(entries=>entries.find(e=>e.text.includes('茉莉花茶')).id)`)
   await evaluate(`window.openbot.bots.addMemory('blinky','用户工作时习惯喝无糖绿茶。')`)
   await evaluate(`window.openbot.bots.removeMemory('blinky',${JSON.stringify(old)})`)
   ws.close();app.kill('SIGTERM');await new Promise(resolve=>app.once('exit',resolve));await delay(300)
   app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
   const memories=await evaluate(`window.openbot.bots.memory('blinky').then(entries=>entries.map(e=>e.text))`)
   if(!memories.includes('用户工作时习惯喝无糖绿茶。')||memories.some(text=>text.includes('茉莉花茶')))throw Error('Memory correction did not survive restart: '+JSON.stringify(memories))
   console.log(JSON.stringify({legacyOffMigrated:true,grokFallback:'codex',readOnly:true,memoryStored:true,correctionSurvivesRestart:true}))
 }
} finally {if(ws)ws.close();app.kill('SIGTERM');await delay(400);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
