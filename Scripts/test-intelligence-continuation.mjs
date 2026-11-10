/** Isolated Electron test: lead -> MCP delegation -> independent executor -> durable lead reply. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
if (process.platform !== 'darwin') throw new Error('This Electron test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-intelligence-'))
const data = path.join(root, 'data')
const fake = path.join(root, 'fake-codex')
const trace = path.join(root, 'trace')
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
await fs.writeFile(fake, String.raw`#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const line = args.find(x => x.startsWith('mcp_servers.openbot=')) || '';
const url = line.match(/url="([^"]+)"/)?.[1];
const tokenName = line.match(/bearer_token_env_var="([^"]+)"/)?.[1];
const owner = process.ppid; setInterval(()=>{ try { process.kill(owner, 0) } catch { process.exit(0) } }, 200).unref();
let model='', n=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const emit=(turn,text,status='completed')=>{ const item='item-'+turn; send({method:'item/started',params:{item:{type:'agentMessage',id:item,phase:'final_answer',text:''}}}); if(text) send({method:'item/agentMessage/delta',params:{itemId:item,delta:text}}); send({method:'turn/completed',params:{turn:{id:turn,status,items:[],...(status==='failed'?{error:{message:'simulated failure'}}:{})}}}); };
readline.createInterface({input:process.stdin}).on('line', async line=>{ try { const r=JSON.parse(line);
 if (r.method==='initialize') send({id:r.id,result:{}});
 else if (r.method==='model/list') send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'},{model:'executor-model',displayName:'Executor'}],nextCursor:null}});
 else if (r.method==='thread/start'||r.method==='thread/resume') { model=r.params.model||model; send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'test-'+model}}}); }
 else if (r.method==='turn/start') { const turn='turn-'+(++n); const text=r.params.input[0].text; send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{turn:{id:turn},threadId:'test-'+model}});
   if(model==='executor-model'&&!url) emit(turn,'[]');
   else if(model==='executor-model') { const seen=fs.existsSync(process.env.BLD_TRACE)&&fs.readFileSync(process.env.BLD_TRACE,'utf8').includes('worker-first'); fs.appendFileSync(process.env.BLD_TRACE,seen?'worker-continued\n':'worker-first\n'); if(seen&&process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1')fs.writeFileSync(process.env.BLD_OUTPUT,'fixture output');setTimeout(()=>emit(turn, seen?'worker-complete':'worker-partial'),300); }
   else if(text.includes('worker-partial')) { const match=text.match(/<agent_result>(.*?)<\/agent_result>/s); if(!match) throw Error('missing task data'); const data=JSON.parse(match[1]); if(!data.taskId) throw Error('missing task id'); if(process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1'){const check=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:14,method:'tools/call',params:{name:'review_task',arguments:{task_id:data.taskId,outcome:'complete_claimed',summary:'premature',evidence:['Executor claimed success']}}})});const verdict=await check.json();if(!verdict.result?.isError)throw Error('missing output did not reject completion');fs.appendFileSync(process.env.BLD_TRACE,'missing-file-rejected\n')} const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:12,method:'tools/call',params:{name:'delegate_task',arguments:{continue_task_id:data.taskId,prompt:'Finish the remaining isolated work.'}}})}); const result=await response.json(); fs.appendFileSync(process.env.BLD_TRACE,'continued:'+response.status+':'+JSON.stringify(result)+'\n'); if(!response.ok||result.error||result.result?.isError) throw Error('continuation rejected'); emit(turn,process.env.BLINKY_SILENT_CONTINUATION==='1'?'':'lead-continues-work'); }
   else if(text.includes('worker-complete')) { const match=text.match(/<agent_result>(.*?)<\/agent_result>/s);if(!match)throw Error('missing task result');const data=JSON.parse(match[1]);const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:13,method:'tools/call',params:{name:'review_task',arguments:{task_id:data.taskId,outcome:'complete_claimed',summary:'lead-integrated-result',evidence:['The isolated worker returned its expected result.']}}})});const result=await response.json();if(!response.ok||result.error||result.result?.isError)throw Error('review rejected');fs.appendFileSync(process.env.BLD_TRACE,'lead-received-result\n');emit(turn,'review recorded'); }
   else { if(!url||!tokenName||!process.env[tokenName]) throw Error('missing gateway configuration'); const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'delegate_task',arguments:{prompt:'Complete the isolated test work.',title:'Isolated test',...(process.env.BLINKY_TEST_TEAMMATE==='1'?{to_bot_id:'teammate'}:{}),...(process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1'?{output_files:[{path:'artifact.txt'}]}:{})}}})}); const result=await response.json(); fs.appendFileSync(process.env.BLD_TRACE,'delegate:'+response.status+':'+JSON.stringify(result)+'\n'); if (!response.ok||result.error||result.result?.isError) throw Error('delegation rejected'); emit(turn,'lead-started-task'); }
 }
 } catch(e) { fs.appendFileSync(process.env.BLD_TRACE,'error:'+e.message+'\n'); process.exitCode=1; } });
`)
await fs.chmod(fake, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data, 'bots', 'blinky.json'), JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'Test bot',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,executionAgent:{backendId:'codex',modelId:'executor-model'},tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
if(process.env.BLINKY_TEST_TEAMMATE==='1')await fs.writeFile(path.join(data,'bots','teammate.json'),JSON.stringify({id:'teammate',name:'Teammate',description:'test',systemPrompt:'Test teammate',emoji:'🔧',color:'#7c9cff',backendId:'codex',modelId:'executor-model',followsDefault:false,tools:['remember'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let logs=''; const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLD_TRACE:trace,BLD_OUTPUT:path.join(root,'artifact.txt')},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws; let restartApp; let seq=0; const pending=new Map()
function cmd(method,params={}) { const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))}) }
async function evalJs(expression) { const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(v.exceptionDetails.text+' '+JSON.stringify(v.exceptionDetails.exception));return v.result.value }
async function wait(expr,ms=30000) {const end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expr))return;await delay(100)}throw Error('timeout: '+expr+' logs: '+logs.slice(-2500)+' trace: '+await fs.readFile(trace,'utf8').catch(()=>''))}
try {
 let targets; const end=Date.now()+30000;while(Date.now()<end){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw Error('no target '+logs.slice(-2500))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);if(m.error)x.reject(Error(JSON.stringify(m.error)));else x.resolve(m.result)}}
 await wait(`Boolean(document.querySelector('#ob-prompt'))`)
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex'&&x.status==='available'))`,40000)
 if(process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1')await evalJs(`window.openbot.bots.list().then(bs=>window.openbot.sessions.setCwd(bs.find(b=>b.id==='blinky').activeConversationId,${JSON.stringify(root)}))`)
 if(process.env.BLINKY_TEST_TEAMMATE==='1')await evalJs(`window.openbot.bots.list().then(bs=>window.openbot.sessions.addBot(bs.find(b=>b.id==='blinky').activeConversationId,'teammate'))`)
 const prompt=process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1'?'Please delegate this test and create artifact.txt in the workspace.':'Please delegate this test.'
 await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await wait(`(async()=>{const t=await window.openbot.tasks.list();return t.filter(x=>x.title==='Isolated test' && x.deliveryStatus==='delivered').length===2})()`,process.env.BLINKY_SILENT_CONTINUATION==='1'?12000:45000)
 const state=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {tasks:await window.openbot.tasks.list(),messages:s.messages.map(x=>({role:x.role,content:x.content,internal:x.internal}))}})()`)
 const first=state.tasks.find(x=>x.result==='worker-partial');const next=state.tasks.find(x=>x.result==='worker-complete')
 if(!first||!next||next.continuedFromTaskId!==first.id||next.sessionId!==first.sessionId||(process.env.BLINKY_TEST_TEAMMATE==='1'?(next.botId!=='teammate'||next.requesterBotId!=='blinky'):next.executionAgent.modelId!=='executor-model')) throw Error('continuation lost task/session/agent: '+JSON.stringify(state.tasks))
 if(state.messages.filter(x=>x.role==='assistant'&&x.content.includes('lead-integrated-result')).length!==1) throw Error('missing final reply: '+JSON.stringify(state.messages))
 if(state.messages.filter(x=>x.internal&&x.content.includes('worker-partial')).length!==1||state.messages.filter(x=>x.internal&&x.content.includes('worker-complete')).length!==1) throw Error('result delivery not exactly once: '+JSON.stringify(state.messages))
 const returned=state.messages.find(x=>x.internal&&x.content.includes('worker-complete'))?.content.match(/<agent_result>(.*?)<\/agent_result>/s)
 const objective=returned&&JSON.parse(returned[1]).objective
 if(!objective?.includes('Complete the isolated test work.')||!objective.includes('Finish the remaining isolated work.'))throw Error('the continued result lost the original objective or latest instruction')
 const evidence=await fs.readFile(trace,'utf8');if(!evidence.includes('worker-first')||!evidence.includes('worker-continued')||!evidence.includes('lead-received-result'))throw Error('missing continuation trace: '+evidence)
 if(process.env.BLINKY_TEST_FILE_ACCEPTANCE==='1'&&(!evidence.includes('missing-file-rejected')||next.acceptance?.files?.[0]?.path!=='artifact.txt'||next.review?.verifiedFiles?.[0]?.path!=='artifact.txt'||first.review))throw Error('output condition was not enforced across continuation')
 // Reopen the same isolated data and read the persisted task and result input
 // from the real application rather than assuming the in-memory state survived.
 ws.close(); app.kill('SIGTERM'); await new Promise(resolve=>app.once('exit',resolve))
 const restartPort=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 restartApp=spawn(electron,['.',`--remote-debugging-port=${restartPort}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLD_TRACE:trace,BLD_OUTPUT:path.join(root,'artifact.txt')},stdio:['ignore','pipe','pipe']});restartApp.stdout.on('data',x=>logs+=x);restartApp.stderr.on('data',x=>logs+=x)
 let restartTargets;const restartEnd=Date.now()+30000;while(Date.now()<restartEnd){try{restartTargets=await(await fetch(`http://127.0.0.1:${restartPort}/json/list`)).json();if(restartTargets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!restartTargets?.some(t=>t.type==='page'))throw Error('no restarted target '+logs.slice(-2500))
 ws=new WebSocket(restartTargets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);if(m.error)x.reject(Error(JSON.stringify(m.error)));else x.resolve(m.result)}}
 await wait(`Boolean(document.querySelector('#ob-prompt'))`)
 const restored=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {tasks:await window.openbot.tasks.list(),messages:s.messages}})()`)
 const restoredTask=restored.tasks.find(x=>x.id===next.id), restoredInput=restored.messages.find(x=>x.internal&&x.content.includes('worker-complete'))?.content.match(/<agent_result>(.*?)<\/agent_result>/s)
 if(restoredTask?.continuedFromTaskId!==first.id||restoredTask?.review?.outcome!=='complete_claimed'||!restoredInput||JSON.parse(restoredInput[1]).objective!==objective)throw Error('continuation objective or assessment did not survive restart')
 console.log(JSON.stringify({partialReviewed:true,continuedSameSession:true,continuedSameAgent:true,originalObjectiveRetained:true,deliveredEachOnce:true,finalReply:true,restartedReadback:true}))
} finally { if(ws)ws.close();app.kill('SIGTERM');restartApp?.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL');if(restartApp&&restartApp.exitCode===null)restartApp.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true}) }
