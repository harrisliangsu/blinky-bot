// Isolated, same-model cold/warm text-only measurements. No real settings are changed.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const variant=process.argv[2]??'baseline', repo=process.cwd(), root=await fs.mkdtemp(path.join(os.tmpdir(),`blinky-stages-${variant}-`)),data=path.join(root,'data'),workspace=path.join(root,'workspace'),proxy=path.join(root,'codex.cjs'),wire=path.join(root,'wire.jsonl')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(workspace)
await fs.writeFile(proxy,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),readline=require('node:readline'),{spawn}=require('node:child_process');
const child=spawn(process.env.BLINKY_STAGE_CODEX,process.argv.slice(2),{stdio:['pipe','pipe','pipe']}),calls=new Map();let turn=0;
const note=value=>fs.appendFileSync(process.env.BLINKY_STAGE_WIRE,JSON.stringify({at:Date.now(),pid:process.pid,turn,...value})+'\n');
const allowed=new Set(['initialize','thread/start','thread/resume','model/list','turn/start']);
note({kind:'process',appServer:process.argv[2]==='app-server'});child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
const input=readline.createInterface({input:process.stdin});input.on('line',line=>{try{const m=JSON.parse(line);if(allowed.has(m.method)){if(m.method==='turn/start')turn++;calls.set(m.id,m.method);note({kind:'request',method:m.method,model:m.params?.model??null})}}catch{}child.stdin.write(line+'\n')});input.on('close',()=>child.stdin.end());
readline.createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(calls.has(m.id)){const method=calls.get(m.id);calls.delete(m.id);note({kind:'response',method,...(typeof m.result?.model==='string'?{resolvedModel:m.result.model}:{}),error:!!m.error})}if(m.method==='mcpServer/startupStatus/updated')note({kind:'mcp-startup',status:['starting','ready','failed','cancelled'].includes(m.params?.status)?m.params.status:'other'});if(m.method==='codex/event/mcp_startup_update'||m.method==='codex/event/mcp_startup_complete')note({kind:'mcp-startup',method:m.method,status:['starting','ready','failed','cancelled'].includes(m.params?.msg?.status?.state)?m.params.msg.status.state:'other'});if(m.method==='turn/started'||m.method==='turn/completed'||m.method==='item/agentMessage/delta')note({kind:'event',method:m.method});if(m.method==='item/started'&&['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch'].includes(m.params?.item?.type))note({kind:'native-tool',type:m.params.item.type})}catch{}process.stdout.write(line+'\n')});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('close',code=>process.exit(code??1));
`,{mode:0o700})
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({language:'zh-CN',memoryExtraction:'off',notifications:false,defaultBackendId:'codex',defaultModelId:'default',approvalPolicy:'ask-every-time',backends:{codex:{enabled:true,added:true,command:proxy,extraArgs:[]}}}))
for(const [index,name] of ['Alpha','Beta'].entries())await fs.writeFile(path.join(data,'bots',name.toLowerCase()+'.json'),JSON.stringify({id:name.toLowerCase(),name,systemPrompt:'This is a text-only measurement. Do not use any tools, skills, files or external actions. Reply directly.',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'default',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:index+1,updatedAt:index+1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),launchAt=Date.now(),traces=[]
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLINKY_CHAT_TIMING:'1',BLINKY_STAGE_CODEX:path.join(os.homedir(),'.local/bin/codex'),BLINKY_STAGE_WIRE:wire},stdio:['ignore','pipe','pipe']})
let stdout='';app.stdout.on('data',chunk=>{stdout+=chunk;let at;while((at=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,at);stdout=stdout.slice(at+1);if(line.startsWith('[blinky-chat-timing] ')){try{traces.push(JSON.parse(line.slice(21)))}catch{}}}});app.stderr.resume()
let ws,sequence=0;const pending=new Map(),samples=[]
function command(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout')),10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const x=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(x.exceptionDetails)throw Error('Renderer evaluation failed');return x.result.value}
async function until(expression,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const x=await evaluate(expression);if(x)return x;await delay(50)}throw Error('Timed out: '+expression)}
try{
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}assert.ok(targets?.some(t=>t.type==='page'))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 await until(`!!document.querySelector('#ob-prompt')`);const composerReadyMs=Date.now()-launchAt
 await until(`window.openbot.backends.list().then(a=>a.some(b=>b.id==='codex'&&b.status==='available'))`,45000);const discoveryReadyMs=Date.now()-launchAt
 for(const name of ['Alpha','Beta']){
  await evaluate(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(e=>e.textContent.includes(${JSON.stringify(name)})).click()`)
  await until(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes(${JSON.stringify(name)})`)
  const sessionId=await evaluate(`window.openbot.bots.list().then(b=>b.find(x=>x.id===${JSON.stringify(name.toLowerCase())}).activeConversationId)`)
  await evaluate(`window.openbot.sessions.setCwd(${JSON.stringify(sessionId)},${JSON.stringify(workspace)})`)
  for(const temperature of ['cold','warm']){
   const traceStart=traces.length
   await evaluate(`(()=>{const s=window.stageSample={submittedAt:Date.now(),publicAt:null,bodyAt:null,doneAt:null,approvals:0,errors:[]};const ids=new Set(),priorBodies=new Set(document.querySelectorAll('.ob-msg-answer'));window.stageOff?.();window.stageOff=window.openbot.on(e=>{if((e.sessionId??e.request?.sessionId??e.session?.id)!==${JSON.stringify(sessionId)})return;if(e.type==='message-start'&&e.message.role==='assistant')ids.add(e.message.id);if(e.type==='text-delta'&&ids.has(e.messageId)&&(e.segment?.phase==='partial_answer'||e.segment?.phase==='final_answer')){s.publicAt??=Date.now();queueMicrotask(()=>{if(!s.bodyAt&&Array.from(document.querySelectorAll('.ob-msg-answer')).some(e=>!priorBodies.has(e)&&e.textContent.trim()))s.bodyAt=Date.now()})}if(e.type==='done')s.doneAt=Date.now();if(e.type==='error')s.errors.push(e.message);if(e.type==='approval-request'){s.approvals++;void window.openbot.agent.respondToApproval(e.request.id,'reject')}});return window.openbot.agent.send(${JSON.stringify(sessionId)},'Reply exactly LATENCY_OK. Do not use any tools, skills, files or external actions.')})()`)
   await until(`window.stageSample.doneAt`);await delay(80)
   const s=await evaluate(`window.stageSample`),events=traces.slice(traceStart).filter(t=>t.sessionId===sessionId),at=stage=>events.find(t=>t.stage===stage)?.at??null,span=(a,b)=>at(a)!==null&&at(b)!==null?at(b)-at(a):null
   const firstBody=at('first-body-text'),row={name,temperature,submittedAt:s.submittedAt,firstModelTextMs:firstBody===null?null:firstBody-s.submittedAt,firstRendererDeltaMs:s.publicAt-s.submittedAt,paintMs:s.bodyAt===null?null:s.bodyAt-s.submittedAt,doneMs:s.doneAt-s.submittedAt,receiptMs:span('submit-received','user-recorded'),backendInfoMs:span('backend-info-start','backend-info-ready'),modelInfoMs:span('model-info-start','model-info-ready'),contextMs:span('context-start','context-ready'),gatewayMs:span('gateway-start','gateway-ready'),environmentMs:span('environment-start','environment-ready'),spawnToRuntimeMs:span('process-spawn-start','runtime-ready'),runtimeToThreadMs:span('runtime-ready','thread-ready'),requestToAcceptedMs:span('model-request','model-request-accepted'),requestToPublicMs:span('model-request','first-body-text'),beforeRequestMs:at('model-request')===null?null:at('model-request')-s.submittedAt,warmReused:at('warm-reused')!==null,errors:s.errors,approvals:s.approvals}
   assert.ok(firstBody);assert.equal(s.errors.length,0);assert.equal(s.approvals,0);if(temperature==='warm')assert.equal(row.warmReused,true)
   samples.push(row);console.log(JSON.stringify({variant,...row}));await delay(150)
  }
 }
 const shapes=(await fs.readFile(wire,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
 assert.equal(shapes.filter(s=>s.kind==='native-tool').length,0)
 const modelReplies=shapes.filter(s=>s.kind==='response'&&s.resolvedModel).map(s=>s.resolvedModel);assert.ok(modelReplies.length);assert.equal(new Set(modelReplies).size,1)
 const report={variant,root,requestedModel:'default',resolvedModel:modelReplies[0],composerReadyMs,discoveryReadyMs,samples,traces,wire:shapes,bundleSha256:createHash('sha256').update(await fs.readFile(path.join(repo,'out/main/index.js'))).digest('hex')}
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({variant,root,composerReadyMs,discoveryReadyMs,resolvedModel:report.resolvedModel,passed:true}))
}finally{ws?.close();app.kill('SIGTERM');for(let i=0;i<30&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(data,{recursive:true,force:true});await fs.rm(proxy,{force:true});await fs.rm(workspace,{recursive:true,force:true})}
