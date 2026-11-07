/** Isolated Electron chat using fake Codex and a disposable high-risk shell action. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-app-gate-')),data=path.join(root,'data'),fake=path.join(root,'codex'),mock=path.join(root,'mock.cjs'),trace=path.join(root,'send'),mode=path.join(root,'mode'),receipts=path.join(root,'receipts'),protectedFile=path.join(root,'protected')
const fetchMode=process.env.BLINKY_TEST_FETCH==='1',gatewayFail=process.env.BLINKY_TEST_GATE_FAIL==='1';let posted=0
const fixture=http.createServer((req,res)=>{posted++;res.end('fixture')});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
const fixtureUrl=`http://127.0.0.1:${fixture.address().port}/submit`
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(repo,'node_modules','.cache'),{recursive:true})
const helperDir=await fs.mkdtemp(path.join(repo,'node_modules','.cache','blinky-keygen-')),helper=path.join(helperDir,'main.cjs')
await fs.writeFile(helper,`const {app,safeStorage}=require('electron');const fs=require('node:fs');app.setName('BlinkyBot');app.setPath('userData',process.env.BLINKY_SMOKE_DIR);app.whenReady().then(()=>{if(!safeStorage.isEncryptionAvailable())throw Error('safeStorage unavailable');const c={clientId:'123456789-test.apps.googleusercontent.com',refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],account:'sender@example.test'};fs.writeFileSync(process.env.BLINKY_SMOKE_DIR+'/google-connections.json',JSON.stringify({version:1,values:{gmail:safeStorage.encryptString(JSON.stringify(c)).toString('base64')}}),{mode:0o600});app.exit(0)}).catch(()=>app.exit(1));`)
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
await new Promise((resolve,reject)=>{const p=spawn(electron,[helper],{env:{...process.env,BLINKY_SMOKE_DIR:data},stdio:'ignore'});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(Error('could not create isolated encrypted fixture')))})
assert.ok(!(await fs.readFile(path.join(data,'google-connections.json'),'utf8')).includes('fixture-refresh'))
await fs.writeFile(mode,'success');await fs.writeFile(protectedFile,'fixture')
await fs.writeFile(mock,String.raw`
const fs=require('node:fs'),original=globalThis.fetch;
if(process.env.GATE_FAIL==='1'){const http=require('node:http'),listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){if(args[0]?.host==='127.0.0.1'&&args[0]?.port===0){process.nextTick(()=>this.emit('error',Error('isolated gateway failure')));return this}return listen.apply(this,args)}}
globalThis.fetch=async function(input,init){const url=new URL(String(input));if(url.origin==='https://oauth2.googleapis.com'){fs.appendFileSync(process.env.MAIL_DEBUG,'refresh\n');return Response.json({access_token:'fixture-access',expires_in:3600})}if(url.origin==='https://openidconnect.googleapis.com')return Response.json({email:'sender@example.test',email_verified:true});if(url.origin==='https://gmail.googleapis.com'&&url.pathname.endsWith('/profile'))return Response.json({emailAddress:'sender@example.test'});if(url.origin==='https://gmail.googleapis.com'&&url.pathname.endsWith('/messages/send')){fs.appendFileSync(process.env.MAIL_TRACE,String(init.body)+'\n');const mode=fs.readFileSync(process.env.MAIL_MODE,'utf8');if(mode==='failure')return new Response('',{status:500});if(mode==='hang')return new Promise(()=>{});return Response.json({id:'fixture-msg-1'})}if(url.hostname.endsWith('googleapis.com')||url.hostname==='accounts.google.com')throw Error('unexpected Google URL in isolated test');return original(input,init)};
`)
await fs.writeFile(fake,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],token=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'gmail-test'}}});else if(r.method==='turn/start'){fs.writeFileSync(process.env.GATE_NATIVE_TRACE,'started');const turn='t'+(++n),text=r.params.input[0].text;fs.appendFileSync(process.env.GATE_INPUT_TRACE,JSON.stringify(text)+'\n');send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'gmail-test'}});if(text.includes('<gmail_receipt>')){fs.appendFileSync(process.env.MAIL_RECEIPTS,text+'\n');if(process.env.MAIL_PAUSE_RECEIPT==='1')return}if(text.includes('HIGH_RISK')&&!text.includes('SAFE_FOLLOWUP')){const target=process.env.GATE_FETCH==='1'?{name:'fetch',arguments:{url:process.env.GATE_URL,method:'post',body:'fixture'}}:{name:'shell',arguments:{command:'rm protected',cwd:process.env.GATE_ROOT}};const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:target})});const result=await response.json();fs.writeFileSync(process.env.MAIL_TRACE,JSON.stringify(result));}send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:'Draft handled'}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}}catch(e){fs.appendFileSync(process.env.MAIL_RECEIPTS,'error:'+e.message+'\n')}})
`);await fs.chmod(fake,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','shell','fetch'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});let logs=''
let pauseReceipt=false
function launch(){const p=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,NODE_OPTIONS:`--require=${mock}`,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,MAIL_TRACE:trace,MAIL_MODE:mode,MAIL_RECEIPTS:receipts,MAIL_DEBUG:path.join(root,'debug'),GATE_TARGET:protectedFile,GATE_ROOT:root,GATE_FETCH:fetchMode?'1':'0',GATE_FAIL:gatewayFail?'1':'0',GATE_NATIVE_TRACE:path.join(root,'native-start'),GATE_INPUT_TRACE:path.join(root,'input-trace'),GATE_URL:fixtureUrl,MAIL_PAUSE_RECEIPT:pauseReceipt?'1':'0'},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function connect(){let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1200));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw Error('timeout '+expression+' logs '+logs.slice(-1000))}
async function stop(){ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function prompt(text){await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`);await prompt('HIGH_RISK')
 if(gatewayFail){
  await wait(`document.body.innerText.includes('应用工具网关未能启动')`,45000)
  await assert.rejects(fs.access(path.join(root,'native-start')))
  assert.equal(await fs.readFile(protectedFile,'utf8'),'fixture')
  console.log(JSON.stringify({realElectron:true,gatewayFailureVisible:true,nativeTurnNotStarted:true}))
 }else{
 await wait(`!!document.querySelector('.ob-transcript .ob-approval')`,45000)
 assert.equal(posted,0,'POST must wait for review')
 assert.equal(await fs.readFile(protectedFile,'utf8'),'fixture','high-risk command must wait for review')
 await delay(600)
 await evaluate(`[...document.querySelectorAll('.ob-approval button')].find(b=>b.textContent.includes('拒绝')).click()`)
 await wait(`window.openbot.activity.list().then(items=>items.some(item=>item.kind==='failed'&&item.detail.includes('操作未获批准')))`)
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky');return !await window.openbot.agent.isRunning(b.activeConversationId)})()`)
 await delay(500);assert.equal(await evaluate(`!!document.querySelector('.ob-approval')`),false,'a rejected action must not prompt again in the stopped turn')
 assert.equal(await fs.readFile(protectedFile,'utf8'),'fixture','rejected command must not run')
 assert.equal(posted,0,'rejected POST must not reach the fixture server')
 await stop();await delay(300);app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 await prompt('SAFE_FOLLOWUP')
 try{await wait(`document.body.innerText.includes('Draft handled')`)}catch(error){console.error('DIAGNOSTIC',JSON.stringify(await evaluate(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.id==='blinky'),s=await window.openbot.sessions.get(b.activeConversationId);return {body:document.body.innerText.slice(-1600),running:await window.openbot.agent.isRunning(b.activeConversationId),queue:await window.openbot.agent.queue(b.activeConversationId),messages:s?.messages.map(m=>({role:m.role,content:m.content,error:m.error,internal:m.internal}))}})()`)));throw error}
 const prompts=(await fs.readFile(path.join(root,'input-trace'),'utf8')).trim().split('\n').map(JSON.parse)
 const followup=prompts.findLast(value=>value.includes('SAFE_FOLLOWUP'))
 assert.ok(followup?.includes('The user rejected'),'next turn must receive the rejection context')
 console.log(JSON.stringify({realElectron:true,codexMocked:true,action:fetchMode?'post':'shell',highRiskWaitedForUser:true,rejectionNotExecuted:true,rejectionStoppedTurn:true,rejectionContextSurvivedRestart:true,userCanContinue:true}))
 }
}finally{await stop();fixture.closeAllConnections();fixture.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(helperDir,{recursive:true,force:true})}
