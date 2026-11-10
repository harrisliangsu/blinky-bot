/** Real Electron, isolated data and a fake CLI; no real webhook or account. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-webhook-test-'))
const data = path.join(root, 'data'), fake = path.join(root, 'codex'), trace = path.join(root, 'trace')
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
const legacyRoutine='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',legacyId='webhook-'+createHash('sha256').update(legacyRoutine+'\0legacy-event').digest('hex')
await fs.mkdir(path.join(data,'webhook-inbox'))
await fs.writeFile(path.join(data,'webhook-inbox',legacyId+'.json'),JSON.stringify({id:legacyId,routineId:legacyRoutine,botId:'blinky',name:'Legacy fixture',instruction:'OLD',createdAt:1,status:'queued'}))
await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const line=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=line.match(/url="([^"]+)"/)?.[1],token=line.match(/bearer_token_env_var="([^"]+)"/)?.[1],parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');function finish(turn,text){send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:text}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'webhook-test'}}});else if(r.method==='turn/start'){const text=r.params.input[0].text,turn='t'+(++n);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'webhook-test'}});if(text.includes('CREATE_WEBHOOK')){const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'create_webhook_routine',arguments:{name:'Fixture hook',instruction:'CHECK_FIXTURE'}}})});const result=await reply.json();if(!reply.ok||result.error||result.result?.isError)throw Error(JSON.stringify(result));finish(turn,'hook saved')}else if(text.includes('[Webhook routine:')){fs.appendFileSync(process.env.WEBHOOK_TRACE,text.includes('UNTRUSTED_BODY')?'body-leaked\n':'triggered\n');finish(turn,'signal checked')}else if(text.includes('HOLD_TURN')){fs.appendFileSync(process.env.WEBHOOK_TRACE,'holding\n');setTimeout(()=>finish(turn,'hold finished'),2500)}else finish(turn,'[]')}}catch(e){fs.appendFileSync(process.env.WEBHOOK_TRACE,'error:'+e.message+'\n')}})
`)
await fs.chmod(fake, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme:'light', language:'zh-CN', notifications:false, defaultBackendId:'codex', defaultModelId:'lead-model', defaultMode:'agent', approvalPolicy:'auto-run', backends:{codex:{enabled:true,command:fake,extraArgs:[]}} }))
await fs.writeFile(path.join(data, 'bots', 'blinky.json'), JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','create_webhook_routine'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})}
const cdp=await freePort(), hook=await freePort(), packaged=process.env.BLINKY_PACKAGED_UI==='1', electron=packaged?'/Applications/BlinkyBot Preview.app/Contents/MacOS/BlinkyBot Preview':path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const blockedPort=process.env.BLINKY_TEST_WEBHOOK_BUSY==='1'?net.createServer():null
if(blockedPort)await new Promise(resolve=>blockedPort.listen(hook,'127.0.0.1',resolve))
let logs='',app,ws,seq=0;const pending=new Map()
function launch(){const p=spawn(electron,[...(packaged?[]:['.']),`--remote-debugging-port=${cdp}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLINKY_TEST_WEBHOOK_PORT:String(hook),WEBHOOK_TRACE:trace},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v)},reject:e=>{clearTimeout(timeout);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error('Renderer evaluation failed');return v.result.value}
async function connect(){let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1200));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expr,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expr))return;await delay(100)}throw Error('timeout '+expr+' trace '+await fs.readFile(trace,'utf8').catch(()=>'')+' logs '+logs.slice(-1800))}
async function stop(){ws?.close();if(!app)return;app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function prompt(text){await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)}
async function count(){return ((await fs.readFile(trace,'utf8').catch(()=>'' )).match(/^triggered$/gm)||[]).length}
async function waitCount(n){for(let i=0;i<300&&await count()<n;i++)await delay(100);assert.equal(await count(),n)}
try {
 app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`);await prompt('CREATE_WEBHOOK')
 for(let i=0;i<100&&!(await fs.readdir(data)).some(x=>x.startsWith('webhook-inbox.migrated-'));i++)await delay(100)
 assert.ok((await fs.readdir(data)).some(x=>x.startsWith('webhook-inbox.migrated-')),'legacy inbox backup was not kept')
 const migrated=new DatabaseSync(path.join(data,'webhook-inbox.sqlite'));try{assert.equal(migrated.prepare('SELECT status FROM signals WHERE id=?').get(legacyId)?.status,'queued')}finally{migrated.close()}
 await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Fixture hook'&&r.trigger.kind==='webhook'))`)
 if(blockedPort){
  await wait(`window.openbot.activity.list().then(items=>items.some(item=>item.title==='Webhook 监听失败'&&item.detail.includes('Fixture hook')))`)
  await new Promise(resolve=>blockedPort.close(resolve))
 }
 const id=await evaluate(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='Fixture hook').id)`)
 const setup=await evaluate(`window.openbot.routines.webhookSetup(${JSON.stringify(id)})`);assert.ok(setup?.secret&&setup.url===`http://127.0.0.1:${hook}/webhooks/${id}`)
 const post=(event,secret=setup.secret,extra={})=>fetch(setup.url,{method:'POST',headers:{authorization:'Bearer '+secret,'x-blinky-event-id':event,...extra},body:'UNTRUSTED_BODY'})
 for(let i=0;i<120;i++){try{const response=await post('probe','x'.repeat(43));if(response.status===403)break}catch{}await delay(100)}
 assert.equal((await post('bad','x'.repeat(43))).status,403);assert.equal((await post('origin',setup.secret,{origin:'https://bad.invalid'})).status,400)
 const concurrent=await Promise.all(Array.from({length:10},()=>post('event-1')));assert.ok(concurrent.every(response=>response.status===202));await waitCount(1);assert.equal((await post('event-1')).status,202);await delay(500);assert.equal(await count(),1)
 await prompt('HOLD_TURN');for(let i=0;i<100&&!(await fs.readFile(trace,'utf8').catch(()=>'' )).includes('holding');i++)await delay(100)
 assert.equal((await post('event-2')).status,202);await delay(500);assert.equal(await count(),1);await waitCount(2)
 assert.ok(!(await fs.readFile(trace,'utf8')).includes('body-leaked'))
 const stored=await fs.readFile(path.join(data,'webhook-secrets',id+'.json'),'utf8');assert.ok(!stored.includes(setup.secret))
 await stop();await delay(300);app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 const setupAgain=await evaluate(`window.openbot.routines.webhookSetup(${JSON.stringify(id)})`);assert.equal(setupAgain.secret,setup.secret)
 for(let i=0;i<50;i++){try{if((await post('event-2')).status===202)break}catch{}await delay(100)}await delay(800);assert.equal(await count(),2)
 await prompt('HOLD_TURN');for(let i=0;i<100&&((await fs.readFile(trace,'utf8').catch(()=>'' )).match(/^holding$/gm)||[]).length<2;i++)await delay(100)
 assert.equal((await post('event-3')).status,202)
 const session=await evaluate(`window.openbot.bots.list().then(bs=>bs.find(b=>b.id==='blinky').activeConversationId)`)
 await wait(`window.openbot.agent.queue(${JSON.stringify(session)}).then(q=>q?.items.some(i=>i.id.startsWith('webhook-')&&i.status==='waiting'))`)
 app.kill('SIGKILL');await new Promise(resolve=>app.once('exit',resolve));ws.close();await delay(300);app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 await wait(`window.openbot.agent.queue(${JSON.stringify(session)}).then(q=>q?.paused&&q.items.some(i=>i.id.startsWith('webhook-')))`)
 await delay(600);assert.equal(await count(),2,'a queued signal must not silently rerun after a crash')
 await evaluate(`window.openbot.agent.pauseQueue(${JSON.stringify(session)}, false)`);await waitCount(3)
 assert.equal((await post('event-3')).status,202);await delay(500);assert.equal(await count(),3)
 const blocker=new DatabaseSync(path.join(data,'webhook-inbox.sqlite'));blocker.exec('BEGIN IMMEDIATE')
 try{
  assert.equal((await post('storage-error')).status,503)
  await wait(`window.openbot.activity.list().then(items=>items.some(item=>item.title==='Webhook 接收失败'))`)
  assert.ok(await evaluate(`window.openbot.activity.list().then(items=>items.some(item=>item.title==='Webhook 接收失败'&&item.detail.includes('Fixture hook')))`))
  assert.equal((await post('storage-error')).status,503)
  assert.equal(await evaluate(`window.openbot.activity.list().then(items=>items.filter(item=>item.title==='Webhook 接收失败').length)`),1)
 }finally{blocker.exec('ROLLBACK');blocker.close()}
 assert.equal((await post('storage-error')).status,202);await waitCount(4)
 assert.equal((await post('storage-error')).status,202);await delay(300);assert.equal(await count(),4)
 console.log(JSON.stringify({createdByBot:true,legacyMigratedInElectron:true,...(blockedPort?{listenerFailureVisibleAndRecovered:true}:{}),encryptedCredential:true,authenticated:true,originRejected:true,deduplicated:true,bodyIgnored:true,busyDeferred:true,restartNoDuplicate:true,crashQueuePausedAndResumed:true,storageFailureVisible:true,failureNoticeDeduplicated:true}))
} finally {blockedPort?.close();await stop();await fs.rm(root,{recursive:true,force:true})}
