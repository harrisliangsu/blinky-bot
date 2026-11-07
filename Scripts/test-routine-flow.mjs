/** Isolated Electron regression for scheduled instructions and crash recovery. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-routine-')),data=path.join(root,'data'),fake=path.join(root,'fake-codex'),trace=path.join(root,'trace')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(data,'routines'),{recursive:true})
await fs.writeFile(fake,String.raw`#!/usr/bin/env node
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],token=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];
const owner=process.ppid;setInterval(()=>{try{process.kill(owner,0)}catch{process.exit(0)}},200).unref();let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
function finish(turn,text){send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:text}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'routine-test-thread'}}});else if(r.method==='turn/start'){const text=r.params.input[0].text,turn='t'+(++n);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'routine-test-thread'}});
if(text.trim().endsWith('USER_SCHEDULE_REQUEST')){if(!url||!process.env[token])throw Error('gateway absent');const invalid=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:19,method:'tools/call',params:{name:'schedule_routine',arguments:{name:'Invalid routine',instruction:'bad',cron:'not cron'}}})});const bad=await invalid.json();if(!bad.error&&!bad.result?.isError)throw Error('invalid schedule was accepted');const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'schedule_routine',arguments:{name:'Created routine',instruction:'MANUAL_ROUTINE_TOKEN',cron:'0 8 * * *'}}})});const body=await reply.json();if(!reply.ok||body.error||body.result?.isError)throw Error('routine tool refused: '+JSON.stringify(body));fs.appendFileSync(process.env.ROUTINE_TRACE,'created\n');finish(turn,'created routine')}
else if(text.trim().endsWith('ROUTINE_EXECUTION_TOKEN')){fs.appendFileSync(process.env.ROUTINE_TRACE,'scheduled\n');finish(turn,'scheduled response')}
else if(text.trim().endsWith('MANUAL_ROUTINE_TOKEN')){fs.appendFileSync(process.env.ROUTINE_TRACE,'manual\n');finish(turn,'manual response')}
else finish(turn,'[]')
}}catch(error){fs.appendFileSync(process.env.ROUTINE_TRACE,'error:'+error.message+'\n');process.exitCode=1}});
`)
await fs.chmod(fake,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','schedule_routine'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const now=Date.now(),base={botId:'blinky',description:'',steps:[],trigger:{kind:'schedule',cron:'0 0 * * *'},replayMode:'adaptive',createdAt:now-26*60*60*1000}
await fs.writeFile(path.join(data,'routines','scheduled.json'),JSON.stringify({...base,id:'scheduled',name:'Scheduled fixture',instruction:'ROUTINE_EXECUTION_TOKEN'}))
await fs.writeFile(path.join(data,'routines','uncertain.json'),JSON.stringify({...base,id:'uncertain',name:'Interrupted fixture',instruction:'DO_NOT_REPLAY',lastRunAt:now,lastRunState:'running'}))
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,ROUTINE_TRACE:trace},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evalJs(expression){const value=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value}
async function connect(){let targets;const deadline=Date.now()+30000;while(Date.now()<deadline){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer: '+logs.slice(-1800));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expression))return;await delay(100)}const state=await evalJs(`(async()=>({active:document.activeElement?.id,text:document.querySelector('[id^="ob-routine-instruction-"]')?.value,routines:await window.openbot.routines.list(),tail:document.body.innerText.slice(-800)}))()`).catch(()=>null);throw Error('timeout '+expression+' state='+JSON.stringify(state)+' trace='+await fs.readFile(trace,'utf8').catch(()=>'')+' logs='+logs.slice(-1500))}
async function stop(){if(ws)ws.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.id==='scheduled'&&r.lastRunState==='finished')&&rs.some(r=>r.id==='uncertain'&&r.lastRunState==='unknown'))`,45000)
 let log=await fs.readFile(trace,'utf8');assert.equal((log.match(/^scheduled$/gm)||[]).length,1);assert.ok(!log.includes('DO_NOT_REPLAY'))
 await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'USER_SCHEDULE_REQUEST');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Created routine'&&r.instruction==='MANUAL_ROUTINE_TOKEN'&&r.trigger.cron==='0 8 * * *'))`,45000)
 assert.equal(await evalJs(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Invalid routine'))`),false)
 const created=await evalJs(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='Created routine'))`)
 await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}))`)
 await wait(`!!document.querySelector('.ob-palette-item')`)
 await evalJs(`[...document.querySelectorAll('.ob-palette-item')].find(x=>x.textContent.trim()==='Routines').click()`)
 await wait(`!![...document.querySelectorAll('.ob-routine-row')].find(x=>x.textContent.includes('Created routine'))`)
 await evalJs(`[...document.querySelectorAll('.ob-routine-row')].find(x=>x.textContent.includes('Created routine')).click()`)
 await wait(`!!document.querySelector('#ob-routine-instruction-${created.id}')`)
 await evalJs(`(()=>{const e=document.querySelector('#ob-routine-instruction-${created.id}');e.focus();e.select()})()`)
 await cmd('Input.insertText',{text:'Updated instruction\nMANUAL_ROUTINE_TOKEN'})
 await delay(100)
 await evalJs(`document.querySelector('#ob-routine-instruction-${created.id}').blur()`)
 await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.id===${JSON.stringify(created.id)}&&r.instruction==='Updated instruction\\nMANUAL_ROUTINE_TOKEN'))`,8000)
 await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
 const bot=await evalJs(`window.openbot.bots.list().then(bs=>bs.find(b=>b.id==='blinky'))`)
 await evalJs(`window.openbot.routines.run(${JSON.stringify(created.id)},${JSON.stringify(bot.activeConversationId)})`)
 await wait(`window.openbot.sessions.get(${JSON.stringify(bot.activeConversationId)}).then(s=>s.messages.some(m=>m.content?.includes('manual response')))`,45000)
 const disk=JSON.parse(await fs.readFile(path.join(data,'routines',created.id+'.json'),'utf8'));assert.equal(disk.instruction,'Updated instruction\nMANUAL_ROUTINE_TOKEN')
 await stop();await delay(300);app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`);await delay(1500)
 log=await fs.readFile(trace,'utf8');assert.equal((log.match(/^scheduled$/gm)||[]).length,1);assert.equal((log.match(/^manual$/gm)||[]).length,1)
 console.log(JSON.stringify({scheduledOnce:true,unknownNotReplayed:true,createdThroughTool:true,instructionEditedInUi:true,manualRun:true,instructionPersisted:true,noDuplicateAfterRestart:true}))
} finally {await stop();await fs.rm(root,{recursive:true,force:true})}
