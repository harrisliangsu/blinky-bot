/** Isolated Electron regression using a local fake GitHub CLI and fake Codex. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-watch-')),data=path.join(root,'data'),bin=path.join(root,'bin'),trace=path.join(root,'trace'),state=path.join(root,'watch-state')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(bin);await fs.writeFile(state,'2026-01-01T00:00:00Z')
const shell=path.join(root,'shell'),gh=path.join(bin,'gh'),codex=path.join(bin,'codex')
await fs.writeFile(shell,`#!/bin/sh\nprintf '__openbot_env__\\nPATH=${bin}:/usr/bin:/bin\\nHOME=${root}\\n'\n`)
await fs.writeFile(gh,`#!${process.execPath}\nconst fs=require('fs');const updated=fs.readFileSync(process.env.WATCH_STATE,'utf8');if(updated==='bad'){process.exit(1)}console.log(JSON.stringify({number:12,url:'https://api.github.com/repos/example/project/issues/12',updated_at:updated,state:'open',title:'Fixture',body:'Private fixture',comments:0,labels:[],assignees:[]}))\n`)
await fs.writeFile(codex,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const line=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=line.match(/url="([^"]+)"/)?.[1],token=line.match(/bearer_token_env_var="([^"]+)"/)?.[1],parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');function finish(turn,text){send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:text}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'watch-test'}}});else if(r.method==='turn/start'){const text=r.params.input[0].text,turn='t'+(++n);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'watch-test'}});if(text.includes('CREATE_WATCH')){const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'watch_github_issue',arguments:{name:'Fixture watch',instruction:'WATCH_INSTRUCTION',owner:'example',repo:'project',issue_number:12}}})});const result=await reply.json();if(!reply.ok||result.error||result.result?.isError)throw Error(JSON.stringify(result));finish(turn,'watch saved')}else if(text.includes('[GitHub issue changed:')){fs.appendFileSync(process.env.WATCH_TRACE,'triggered\n');finish(turn,'change checked')}else if(text.includes('HOLD_TURN')){fs.appendFileSync(process.env.WATCH_TRACE,'holding\n');setTimeout(()=>finish(turn,'hold finished'),3500)}else finish(turn,'[]')}}catch(e){fs.appendFileSync(process.env.WATCH_TRACE,'error:'+e.message+'\n')}})
`)
for(const f of [shell,gh,codex])await fs.chmod(f,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:codex,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','watch_github_issue'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
function launch(){const p=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,HOME:root,SHELL:shell,PATH:`${bin}:/usr/bin:/bin`,GH_TOKEN:'',GITHUB_TOKEN:'',BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLINKY_TEST_WATCH_POLL_MS:'1',WATCH_STATE:state,WATCH_TRACE:trace},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function connect(){let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1200));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expr,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expr))return;await delay(100)}throw Error('timeout '+expr+' trace '+await fs.readFile(trace,'utf8').catch(()=>'')+' logs '+logs.slice(-1800))}
async function stop(){ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function sendPrompt(text){await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)}
async function count(){return ((await fs.readFile(trace,'utf8').catch(()=>'' )).match(/^triggered$/gm)||[]).length}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`);await sendPrompt('CREATE_WATCH')
 await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Fixture watch'&&r.trigger.kind==='github_issue'&&r.watchCursor))`,45000)
 await delay(1700);assert.equal(await count(),0,'baseline and unchanged polls must be silent')
 await fs.writeFile(state,'2026-01-02T00:00:00Z');await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Fixture watch'&&r.lastRunState==='finished'))`)
 assert.equal(await count(),1);await delay(1600);assert.equal(await count(),1,'unchanged poll must not repeat')
 const before=await evaluate(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='Fixture watch').watchCursor)`)
 await fs.writeFile(state,'bad');await wait(`window.openbot.routines.list().then(rs=>!!rs.find(r=>r.name==='Fixture watch').watchError)`)
 assert.equal(await evaluate(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='Fixture watch').watchCursor)`),before)
 await fs.writeFile(state,'2026-01-02T00:00:00Z');await wait(`window.openbot.routines.list().then(rs=>!rs.find(r=>r.name==='Fixture watch').watchError)`)
 await sendPrompt('HOLD_TURN');for(let i=0;i<100&&!(await fs.readFile(trace,'utf8').catch(()=>'' )).includes('holding');i++)await delay(100)
 await fs.writeFile(state,'2026-01-03T00:00:00Z');await delay(1500);assert.equal(await count(),1,'busy chat must defer the change')
 for(let i=0;i<100&&await count()<2;i++)await delay(100);assert.equal(await count(),2,'deferred change must run')
 await stop();await delay(300);app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`);await delay(1800);assert.equal(await count(),2,'restart must not repeat an observed change')
 const disk=JSON.parse(await fs.readFile(path.join(data,'routines',(await evaluate(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='Fixture watch').id)`))+'.json'),'utf8'));assert.equal(disk.trigger.kind,'github_issue');assert.ok(!JSON.stringify(disk).includes('Private fixture'))
 console.log(JSON.stringify({createdByBot:true,baselineQuiet:true,oneRunPerChange:true,errorPreservesCursor:true,busyChatDeferred:true,restartNoDuplicate:true,contentNotStored:true}))
}finally{await stop();await fs.rm(root,{recursive:true,force:true})}
