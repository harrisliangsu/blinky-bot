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
   if(model==='executor-model'||text.includes('You are an independent background execution agent.')) { fs.appendFileSync(process.env.BLD_TRACE,'executor-model\n'); if(process.env.BLINKY_TEST_WORKER_DRAFT==='1'){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name:'github_comment_draft',arguments:{owner:'example',repo:'project',issue_number:12,body:'Worker draft'}}})});const reply=await response.json();if(!response.ok||reply.error||reply.result?.isError)throw Error('worker draft failed '+JSON.stringify(reply));fs.appendFileSync(process.env.BLD_TRACE,'worker-drafted\n')} send({method:'item/started',params:{item:{type:'commandExecution',id:'cmd-1',command:'echo test',status:'inProgress'}}}); send({method:'item/completed',params:{item:{type:'commandExecution',id:'cmd-1',command:'echo test',status:'completed',aggregatedOutput:'test'}}}); send({method:'item/started',params:{item:{type:'agentMessage',id:'work-item',phase:'final_answer',text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:'work-item',delta:'worker-live'}}); if(process.env.BLINKY_TEST_EXECUTOR_CRASH==='1')setTimeout(()=>{fs.appendFileSync(process.env.BLD_TRACE,'executor-crash-fired\n');process.kill(owner,'SIGKILL')},2500);else setTimeout(()=>{send({method:'item/agentMessage/delta',params:{itemId:'work-item',delta:'-result-ok'}}); send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})},5000); }
   else if(process.env.BLINKY_TEST_EXECUTOR_CRASH==='1' && text.includes('<agent_result>')) {const data=JSON.parse(text.match(/<agent_result>(.*?)<\/agent_result>/s)[1]);const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:93,method:'tools/call',params:{name:'review_task',arguments:{task_id:data.taskId,outcome:'blocked',summary:'execution interrupted; inspect before retry',evidence:[]}}})});const result=await response.json();if(!response.ok||result.error||result.result?.isError)throw Error('interrupted review failed');emit(turn,'interrupted review recorded')}
   else if(text.includes('worker-live-result-ok') || text.includes('still has no recorded assessment or continuation')) {
     const match=text.match(/<agent_result>(.*?)<\/agent_result>/s); const taskId=match?JSON.parse(match[1]).taskId:text.match(/task ([a-zA-Z0-9-]+) still/)?.[1];
     if(!taskId)throw Error('missing review task id');
     if(process.env.BLINKY_TEST_REVIEW_NEVER==='1' || (process.env.BLINKY_TEST_REVIEW_NUDGE==='1' && !fs.readFileSync(process.env.BLD_TRACE,'utf8').includes('review-nudged'))) {fs.appendFileSync(process.env.BLD_TRACE,'review-nudged\n');emit(turn,'premature complete claim');}
     else {if(process.env.BLINKY_TEST_REVIEW_REJECT==='1'){for(const args of [{task_id:taskId,outcome:'complete_claimed',summary:'missing evidence'}, {task_id:'foreign-task',outcome:'complete_claimed',summary:'wrong owner',evidence:['test']}]){const bad=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:14,method:'tools/call',params:{name:'review_task',arguments:args}})});const rejected=await bad.json();if(!rejected.error&&!rejected.result?.isError)throw Error('invalid review was accepted');}}const blocked=process.env.BLINKY_TEST_REVIEW_BLOCKED==='1';const review={task_id:taskId,outcome:blocked?'blocked':'complete_claimed',summary:blocked?'await user decision':'lead-integrated-result',evidence:blocked?[]:['The isolated worker returned its expected result.']};const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:13,method:'tools/call',params:{name:'review_task',arguments:review}})});const result=await response.json();if(!response.ok||result.error||result.result?.isError)throw Error('review rejected: '+JSON.stringify(result));fs.appendFileSync(process.env.BLD_TRACE,'lead-received-result\n');if(process.env.BLINKY_TEST_REVIEW_CRASH==='1'){fs.appendFileSync(process.env.BLD_TRACE,'review-crash-fired\n');process.kill(owner,'SIGKILL');return;}emit(turn,process.env.BLINKY_SILENT_REVIEW==='1'?'':'review recorded');}
   }
   else { if(!url||!tokenName||!process.env[tokenName]) throw Error('missing gateway configuration'); const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'delegate_task',arguments:{prompt:'Complete the isolated test work.',title:'Isolated test',...(process.env.BLINKY_TEST_TEAMMATE==='1'?{to_bot_id:'teammate'}:{})}}})}); const result=await response.json(); fs.appendFileSync(process.env.BLD_TRACE,'delegate:'+response.status+':'+JSON.stringify(result)+'\n'); if (!response.ok||result.error||result.result?.isError) throw Error('delegation rejected'); emit(turn,process.env.BLINKY_SILENT_START==='1'?'':'lead-started-task'); }
 }
 } catch(e) { fs.appendFileSync(process.env.BLD_TRACE,'error:'+e.message+'\n'); process.exitCode=1; } });
`)
await fs.chmod(fake, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
const executorModel = process.env.BLINKY_TEST_SAME_MODEL === '1' ? 'lead-model' : 'executor-model'
await fs.writeFile(path.join(data, 'bots', 'blinky.json'), JSON.stringify({id:'blinky',name:'Blinky',description:'test',systemPrompt:'Test bot',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,executionAgent:{backendId:'codex',modelId:executorModel},tools:['delegate_task',...(process.env.BLINKY_TEST_WORKER_DRAFT==='1'?['github_comment_draft']:[])],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
if(process.env.BLINKY_TEST_TEAMMATE==='1')await fs.writeFile(path.join(data,'bots','teammate.json'),JSON.stringify({id:'teammate',name:'Teammate',description:'test',systemPrompt:'Test teammate',emoji:'🔧',color:'#7c9cff',backendId:'codex',modelId:'executor-model',followsDefault:false,tools:process.env.BLINKY_TEST_WORKER_DRAFT==='1'?['github_comment_draft']:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let logs='';function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLD_TRACE:trace},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}let app=launch()
let ws; let seq=0; const pending=new Map()
function cmd(method,params={}) { const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))}) }
async function evalJs(expression) { const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(v.exceptionDetails.text+' '+JSON.stringify(v.exceptionDetails.exception));return v.result.value }
async function wait(expr,ms=30000) {const end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expr))return;await delay(100)}throw Error('timeout: '+expr+' logs: '+logs.slice(-2500)+' trace: '+await fs.readFile(trace,'utf8').catch(()=>''))}
async function connect() {
 let targets; const end=Date.now()+30000;while(Date.now()<end){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw Error('no target '+logs.slice(-2500))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);if(m.error)x.reject(Error(JSON.stringify(m.error)));else x.resolve(m.result)}}
}
try {
 await connect()
 await wait(`Boolean(document.querySelector('#ob-prompt'))`)
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex'&&x.status==='available'))`,40000)
 if(process.env.BLINKY_TEST_TEAMMATE==='1')await evalJs(`window.openbot.bots.list().then(bs=>window.openbot.sessions.addBot(bs.find(b=>b.id==='blinky').activeConversationId,'teammate'))`)
 await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Please delegate this test.');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
 await wait(`(async()=>{const t=await window.openbot.tasks.list();return t.some(x=>x.title==='Isolated test' && x.status==='running')})()`,45000)
 if(process.env.BLINKY_TEST_EXECUTOR_CRASH==='1') {
   const deadline=Date.now()+30000;while(Date.now()<deadline&&app.exitCode===null&&app.signalCode===null)await delay(100)
   if(app.exitCode===null&&app.signalCode===null)throw Error('executor crash did not fire')
   ws.close();await delay(300);app=launch();await connect();await wait(`Boolean(document.querySelector('#ob-prompt'))`)
   await wait(`window.openbot.tasks.list().then(ts=>ts.some(t=>t.title==='Isolated test'&&t.status==='failed'&&t.deliveryStatus==='uncertain'))`,45000)
   const task=await evalJs(`window.openbot.tasks.list().then(ts=>ts.find(t=>t.title==='Isolated test'))`)
   const transcript=await evalJs(`window.openbot.sessions.get(${JSON.stringify(task.sessionId)}).then(s=>s.messages)`)
   if(!transcript.some(m=>m.error?.includes('执行中断')&&m.agentTrace?.some(e=>e.kind==='commandExecution'&&e.detail.includes('echo test'))))throw Error('interrupted tool trace missing: '+JSON.stringify(transcript))
   if(process.env.BLINKY_TEST_WORKER_DRAFT==='1'&&!transcript.some(m=>m.agentTrace?.some(e=>e.kind==='github_comment_draft'&&e.phase==='completed')))throw Error('interrupted gateway tool result missing')
   const evidence=await fs.readFile(trace,'utf8');if((evidence.match(/executor-model/g)||[]).length!==1)throw Error('interrupted executor was restarted automatically')
   console.log(JSON.stringify({executorCrash:true,partialTraceRecovered:true,interruptionLabeled:true,noAutomaticRerun:true}))
 } else {
 await evalJs(`document.querySelector('.ob-header-bot-trigger').click()`)
 await wait(`!!document.querySelector('.ob-bot-details-task > summary')`)
 await evalJs(`document.querySelector('.ob-bot-details-task > summary').click()`)
 await evalJs(`document.querySelector('.ob-bot-details-task details > summary').click()`)
 await wait(`document.querySelector('.ob-agent-transcript')?.innerText.includes('worker-live') && document.querySelector('.ob-agent-transcript')?.innerText.includes('commandExecution')`,4000)
 if(await evalJs(`!!document.querySelector('.ob-agent-transcript textarea')`))throw Error('Agent transcript unexpectedly editable')
 if(process.env.BLINKY_TEST_REVIEW_CRASH==='1') {
   const deadline=Date.now()+45000;while(Date.now()<deadline && !(await fs.readFile(trace,'utf8').catch(()=>'' )).includes('review-crash-fired'))await delay(100)
   if(!(await fs.readFile(trace,'utf8')).includes('review-crash-fired'))throw Error('review crash did not fire')
   while(app.exitCode===null && app.signalCode===null)await delay(100)
   ws.close();await delay(300);app=launch();await connect();await wait(`Boolean(document.querySelector('#ob-prompt'))`)
 }
 if(process.env.BLINKY_TEST_REVIEW_NEVER==='1') {
   await wait(`(async()=>{const t=await window.openbot.tasks.list();return t.some(x=>x.title==='Isolated test' && x.deliveryStatus==='uncertain')})()`,45000)
   const messages=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return (await window.openbot.sessions.get(b.activeConversationId)).messages})()`)
   if(messages.some(x=>x.role==='assistant'&&!x.internal&&x.content.includes('premature complete claim')))throw Error('Unreviewed claim was visible')
   console.log(JSON.stringify({unreviewedClaimHidden:true,deliveryUncertain:true}))
 } else {
 await wait(`(async()=>{const t=await window.openbot.tasks.list();return t.some(x=>x.title==='Isolated test' && x.deliveryStatus==='delivered')})()`,45000)
 const state=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return {tasks:await window.openbot.tasks.list(),messages:s.messages.map(x=>({role:x.role,content:x.content,internal:x.internal}))}})()`)
 const task=state.tasks.find(x=>x.title==='Isolated test'); const traceMessages=await evalJs(`window.openbot.sessions.get(${JSON.stringify(task.sessionId)}).then(s=>s.messages)`); if(!traceMessages.some(m=>m.agentTrace?.some(e=>e.kind==='commandExecution' && e.detail.includes('echo test'))))throw Error('Executor trace was not persisted');if(task.status!=='completed'||task.result!=='worker-live-result-ok'||(process.env.BLINKY_TEST_TEAMMATE==='1'?(task.botId!=='teammate'||task.requesterBotId!=='blinky'):task.executionAgent.modelId!==executorModel)) throw Error('wrong executor result: '+JSON.stringify(task))
 if(process.env.BLINKY_TEST_WORKER_DRAFT==='1'){const draft=JSON.parse(await fs.readFile(path.join(data,'github-comment-drafts.json'),'utf8'))[0];if(draft.sessionId!==task.sourceSessionId||draft.status!=='draft')throw Error('worker draft was not linked to source chat');if(!await evalJs(`document.querySelector('.ob-github-draft')?.innerText.includes('Worker draft')`))throw Error('worker draft not visible in lead chat');const entries=traceMessages.flatMap(m=>m.agentTrace??[]).filter(e=>e.kind==='github_comment_draft');if(!entries.some(e=>e.phase==='started')||!entries.some(e=>e.phase==='completed'))throw Error('gateway tool start and result not persisted: '+JSON.stringify(entries))}
 const blocked=process.env.BLINKY_TEST_REVIEW_BLOCKED==='1';const savedTask=JSON.parse(await fs.readFile(path.join(data,'tasks',task.id+'.json'),'utf8'));if(savedTask.review?.outcome!==(blocked?'blocked':'complete_claimed')||(!blocked&&!savedTask.review.evidence?.length))throw Error('Lead assessment not durably saved')
 if(state.messages.filter(x=>x.role==='assistant'&&x.content.includes(blocked?'await user decision':'lead-integrated-result')).length!==1) throw Error('lead did not respond exactly once: '+JSON.stringify(state.messages))
 if(state.messages.some(x=>x.role==='assistant'&&!x.internal&&x.content.includes('premature complete claim')))throw Error('Unreviewed claim was visible')
 if(state.messages.filter(x=>x.internal&&x.content.includes('worker-live-result-ok')).length!==1) throw Error('background result not recorded exactly once: '+JSON.stringify(state.messages))
 const evidence=await fs.readFile(trace,'utf8');if(!evidence.includes('executor-model')||!evidence.includes('lead-received-result'))throw Error('missing executor/lead trace: '+evidence)
 if(process.env.BLINKY_TEST_REVIEW_CRASH==='1' && ((evidence.match(/lead-received-result/g)||[]).length!==1 || (evidence.match(/executor-model/g)||[]).length!==1))throw Error('Restart repeated the lead or executor: '+evidence)
 console.log(JSON.stringify({lateViewerLiveTranscript:true,executorToolTrace:true,mcpDelegation:true,independentSession:true,sameModel:executorModel==='lead-model',leadResumed:true,persistedResult:true,deliveredOnce:true,restartRecovery:process.env.BLINKY_TEST_REVIEW_CRASH==='1'}))
 }
 }
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true}) }
