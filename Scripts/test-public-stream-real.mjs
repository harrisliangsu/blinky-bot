// Fresh isolated app + native CLI text-only request. Never resumes a business task.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const backend = process.argv[2]
const binaries = { codex: path.join(os.homedir(),'.local/bin/codex'), kimi: path.join(os.homedir(),'.kimi-code/bin/kimi'), grok: path.join(os.homedir(),'.local/bin/grok'), claude: '/opt/homebrew/bin/claude', pi: '/opt/homebrew/bin/pi' }
assert.ok(Object.hasOwn(binaries,backend),'Pass codex, kimi, grok, claude or pi')
const repo=process.cwd(), root=await fs.mkdtemp(path.join(os.tmpdir(),`blinky-public-${backend}-`)), data=path.join(root,'data'), workspace=path.join(root,'workspace'), wrapper=path.join(root,'cli-proxy.cjs'), trace=path.join(root,'event-shapes.jsonl')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(workspace)
await fs.writeFile(wrapper,`#!${process.execPath}\n`+String.raw`
const {spawn}=require('node:child_process'),readline=require('node:readline'),fs=require('node:fs');
const child=spawn(process.env.BLINKY_PUBLIC_REAL_BINARY,process.argv.slice(2),{stdio:['pipe','pipe','pipe']});
const authStatus=process.argv[2]==='auth'&&process.argv[3]==='status';let authOutput='';
const input=readline.createInterface({input:process.stdin});input.on('line',line=>child.stdin.write(line+'\n'));input.on('close',()=>child.stdin.end());
child.stdin.on('error',()=>{});child.stderr.pipe(process.stderr);
readline.createInterface({input:child.stdout}).on('line',line=>{
 if(authStatus)authOutput+=line+'\n';
 try {
  const m=JSON.parse(line), p=m.params??{}, item=p.item??m.item??{}, u=p.update??{}, e=m.event??m.assistantMessageEvent??{}, block=e.content_block??{}, delta=e.delta??{};
  const types=(m.message?.content??[]);const shape={at:Date.now(),method:m.method,type:m.type,itemType:item.type,phase:item.phase,update:u.sessionUpdate,contentType:u.content?.type,eventType:e.type,deltaType:delta.type,blockType:block.type,blockTypes:Array.isArray(types)?types.map(x=>x?.type):undefined};
  fs.appendFileSync(process.env.BLINKY_PUBLIC_EVENT_TRACE,JSON.stringify(shape)+'\n');
 }catch{}
 process.stdout.write(line+'\n');
});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill(signal)});
child.on('error',()=>process.exit(1));child.on('close',(code,signal)=>{if(authStatus){let status;try{const value=JSON.parse(authOutput);status={loggedIn:value.loggedIn,authMethod:value.authMethod}}catch{}fs.appendFileSync(process.env.BLINKY_PUBLIC_EVENT_TRACE,JSON.stringify({type:'auth-status',code,status})+'\n')}process.exit(code??(signal?1:0))});
`,{mode:0o700})
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',memoryExtraction:'off',notifications:false,defaultBackendId:backend,defaultModelId:'default',approvalPolicy:'ask',backends:{[backend]:{enabled:true,added:true,command:process.env.BLINKY_PUBLIC_NO_PROXY==='1'?binaries[backend]:wrapper,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','stream.json'),JSON.stringify({id:'stream',name:'Stream',description:'isolated text-only stream verification',systemPrompt:'This is a text-only verification. Do not call tools, load skills, read files, browse, edit anything or change settings. Answer the user directly.',emoji:'✨',color:'#7c9cff',backendId:backend,modelId:'default',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLINKY_PUBLIC_REAL_BINARY:binaries[backend],BLINKY_PUBLIC_EVENT_TRACE:trace},stdio:['ignore','pipe','pipe']})
let ws,seq=0,logs='',sessionId,report={backend,root,passed:false}
app.stdout.on('data',value=>{logs+=value});app.stderr.on('data',value=>{logs+=value})
const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const value=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error('Renderer evaluation failed');return value.result.value}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(50)}throw Error('Timed out: '+expression)}
try {
 let targets;for(let attempt=0;attempt<300;attempt++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 assert.ok(targets?.some(t=>t.type==='page'),'No isolated renderer')
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
 ws.onmessage=event=>{const value=JSON.parse(event.data);if(value.id&&pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(Error(JSON.stringify(value.error))):p.resolve(value.result)}}
 await wait(`!!document.querySelector('#ob-prompt')`)
 if(process.env.BLINKY_PUBLIC_DETECTION_ONLY==='1') {
  assert.equal(backend,'claude')
  await wait(`window.openbot.backends.list().then(items=>items.some(item=>item.id==='claude'&&item.statusDetail?.includes('terminated by SIGKILL')))`,15000)
  const row=await evaluate(`window.openbot.backends.list().then(items=>items.find(item=>item.id==='claude')).then(item=>({id:item.id,status:item.status,detail:item.statusDetail,authState:item.cliAuth?.state}))`)
  assert.equal(row.status,'error')
  assert.match(row.detail,/SIGKILL/)
  report={...report,backendStatus:row,noModelRequests:true,passed:true}
 } else {
 await wait(`window.openbot.backends.list().then(items=>items.some(item=>item.id===${JSON.stringify(backend)}&&item.status==='available'))`,45000)
 sessionId=await evaluate(`window.openbot.bots.list().then(items=>items.find(item=>item.id==='stream')?.activeConversationId)`)
 assert.ok(sessionId)
 await evaluate(`window.openbot.sessions.setCwd(${JSON.stringify(sessionId)},${JSON.stringify(workspace)})`)
 await evaluate(`(()=>{
  const state=window.streamEvidence={startedAt:null,firstPublicAt:null,firstAnswerAt:null,firstBodyAt:null,firstBodyWhileRunning:null,messageEndAt:null,doneAt:null,textEvents:0,answerEvents:0,reasoningEvents:0,privateOnlyProducedProgress:false,progressWithBody:false,approvals:0,errors:[],phases:{}};
  let running=false;
  window.openbot.on(event=>{
   if(event.sessionId&&event.sessionId!==${JSON.stringify(sessionId)})return;
   if(event.type==='run-started'){running=true;state.startedAt=Date.now()}
   if(event.type==='text-delta'){state.textEvents++;state.firstPublicAt??=Date.now();const phase=event.segment?.phase??'unknown';state.phases[phase]=(state.phases[phase]??0)+1;if(phase==='partial_answer'||phase==='final_answer'){state.answerEvents++;state.firstAnswerAt??=Date.now()}}
   if(event.type==='reasoning-delta'){state.reasoningEvents++;if(!state.textEvents&&document.querySelector('.ob-model-progress'))state.privateOnlyProducedProgress=true}
   if(event.type==='message-end'&&state.textEvents)state.messageEndAt=Date.now();
   if(event.type==='done'){running=false;state.doneAt=Date.now()}
   if(event.type==='error'){running=false;state.errors.push(event.message)}
   if(event.type==='approval-request'&&event.request.sessionId===${JSON.stringify(sessionId)}){state.approvals++;void window.openbot.agent.respondToApproval(event.request.id,'reject')}
  });
  new MutationObserver(()=>{const body=document.querySelector('.ob-transcript-content .ob-msg-answer');if(body?.textContent.trim()){if(!state.firstBodyAt){state.firstBodyAt=Date.now();state.firstBodyWhileRunning=running}if(document.querySelector('.ob-model-progress'))state.progressWithBody=true}}).observe(document.querySelector('.ob-transcript-content'),{subtree:true,childList:true,characterData:true});
 })()`)
 const prompt='这是纯文字测试，不要调用任何工具或技能，不读取文件、不访问网页、不修改设置。直接输出：首行 PUBLIC_STREAM_OK；然后逐行列出16种水果，每行写名称和一句简短口感说明；最后一行 STREAM_END。'
 await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 await wait(`window.streamEvidence.doneAt!==null`,150000)
 await delay(100)
 const evidence=await evaluate(`window.streamEvidence`)
 const rendered=await evaluate(`({body:Array.from(document.querySelectorAll('.ob-transcript-content .ob-msg-answer')).map(node=>node.textContent).join(String.fromCharCode(10)),progress:!!document.querySelector('.ob-model-progress')})`)
 const stored=await evaluate(`window.openbot.sessions.get(${JSON.stringify(sessionId)}).then(session=>({uiOnly:session.messages.filter(m=>m.uiOnly).length,errors:session.messages.filter(m=>m.error).map(m=>m.error)}))`)
 const shapes=(await fs.readFile(trace,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse)
 const families={};for(const s of shapes){const kind=s.update??s.eventType??s.method??s.type??'unknown';families[kind]=(families[kind]??0)+1}
 const nativeToolEvents=shapes.filter(s=>['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch'].includes(s.itemType)||s.update==='tool_call'||s.eventType==='tool_start'||s.eventType==='toolCall_start'||s.blockType==='tool_use'||s.blockTypes?.includes('tool_use')).length
 report={...report,evidence:{...evidence,firstPublicMs:evidence.firstPublicAt===null?null:evidence.firstPublicAt-evidence.startedAt,firstBodyMs:evidence.firstBodyAt===null?null:evidence.firstBodyAt-evidence.startedAt,completionMs:evidence.doneAt-evidence.startedAt},wireFamilies:families,nativeToolEvents,uiOnly:stored.uiOnly,replyHasMarkers:rendered.body.includes('PUBLIC_STREAM_OK')&&rendered.body.includes('STREAM_END'),progressCleared:!rendered.progress}
 assert.equal(evidence.errors.length,0,JSON.stringify(evidence.errors));assert.equal(stored.errors.length,0)
 assert.equal(report.replyHasMarkers,true);assert.equal(stored.uiOnly,0)
 assert.equal(evidence.privateOnlyProducedProgress,false);assert.equal(evidence.progressWithBody,false)
 assert.equal(rendered.progress,false);assert.equal(evidence.approvals,0);assert.equal(nativeToolEvents,0)
 assert.ok(evidence.firstBodyAt);assert.ok(evidence.answerEvents)
 if(evidence.answerEvents>1)assert.equal(evidence.firstBodyWhileRunning,true,'Public tokens must paint before the run ends')
 report.passed=true
 }
} catch(error) {
 report.error=String(error)
 if(ws)report.backendStatus=await evaluate(`window.openbot.backends.list().then(items=>items.filter(item=>item.id===${JSON.stringify(backend)}).map(item=>({id:item.id,status:item.status,detail:item.statusDetail})))`).catch(()=>[])
 process.exitCode=1
} finally {
 ws?.close();app.kill('SIGTERM');for(let i=0;i<30&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
 await fs.rm(data,{recursive:true,force:true});await fs.rm(workspace,{recursive:true,force:true});await fs.rm(wrapper,{force:true})
}
