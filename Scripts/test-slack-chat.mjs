/** Isolated Electron chat using fake Slack responses and fake Codex; no real Slack message is sent. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-slack-chat-')),data=path.join(root,'data'),fake=path.join(root,'codex'),mock=path.join(root,'mock.cjs'),trace=path.join(root,'send'),mode=path.join(root,'mode'),receipts=path.join(root,'receipts'),events=path.join(root,'events'),acks=path.join(root,'acks')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(repo,'node_modules','.cache'),{recursive:true})
const helperDir=await fs.mkdtemp(path.join(repo,'node_modules','.cache','blinky-keygen-')),helper=path.join(helperDir,'main.cjs')
await fs.writeFile(helper,`const {app,safeStorage}=require('electron');const fs=require('node:fs');app.setName('BlinkyBot');app.setPath('userData',process.env.BLINKY_SMOKE_DIR);app.whenReady().then(()=>{if(!safeStorage.isEncryptionAvailable())throw Error('safeStorage unavailable');const c={appToken:'xapp-fixture-token-12345',botToken:'xoxb-fixture-token-12345',teamId:'T123',botUserId:'UBOT',allowedUserId:'U123',channelId:'C123',botId:'blinky'};fs.writeFileSync(process.env.BLINKY_SMOKE_DIR+'/slack-connection.json',JSON.stringify({version:1,ciphertext:safeStorage.encryptString(JSON.stringify(c)).toString('base64')}),{mode:0o600});app.exit(0)}).catch(()=>app.exit(1));`)
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
await new Promise((resolve,reject)=>{const p=spawn(electron,[helper],{env:{...process.env,BLINKY_SMOKE_DIR:data},stdio:'ignore'});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(Error('could not create isolated encrypted fixture')))})
assert.ok(!(await fs.readFile(path.join(data,'slack-connection.json'),'utf8')).includes('xapp-fixture-token'))
await fs.writeFile(mode,'success')
await fs.writeFile(events,'')
await fs.writeFile(mock,String.raw`
const fs=require('node:fs'),original=globalThis.fetch;
globalThis.fetch=async function(input,init){const url=new URL(String(input));if(url.origin==='https://slack.com'){if(url.pathname==='/api/apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/test?ticket=fixture'});if(url.pathname==='/api/auth.test')return Response.json({ok:true,team_id:'T123',user_id:'UBOT'});if(url.pathname==='/api/conversations.info')return Response.json({ok:true,channel:{id:'C123',is_member:true}});if(url.pathname==='/api/chat.postMessage'){fs.appendFileSync(process.env.MAIL_TRACE,String(init.body)+'\n');const mode=fs.readFileSync(process.env.MAIL_MODE,'utf8');if(mode==='failure')return new Response('',{status:500});if(mode==='hang')return new Promise(()=>{});return Response.json({ok:true,channel:'C123',ts:'456.789'})}throw Error('unexpected Slack API in isolated test')}return original(input,init)};
class FakeSocket {static OPEN=1;constructor(){this.readyState=1;this.handlers={};this.offset=0;setTimeout(()=>this.emit('message',{data:JSON.stringify({type:'hello'})}),30);this.timer=setInterval(()=>{const lines=fs.readFileSync(process.env.SLACK_EVENTS,'utf8').trim().split('\n').filter(Boolean);for(;this.offset<lines.length;this.offset++)this.emit('message',{data:lines[this.offset]})},50);this.timer.unref()}addEventListener(type,fn){(this.handlers[type]??=[]).push(fn)}emit(type,event){for(const fn of this.handlers[type]??[])fn(event)}send(data){fs.appendFileSync(process.env.SLACK_ACKS,data+'\n')}close(){clearInterval(this.timer);this.readyState=3;this.emit('close',{})}}
globalThis.WebSocket=FakeSocket;
`)
await fs.writeFile(fake,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],token=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'gmail-test'}}});else if(r.method==='turn/start'){const turn='t'+(++n),text=r.params.input[0].text;send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'gmail-test'}});if(text.includes('<slack_receipt>')){fs.appendFileSync(process.env.MAIL_RECEIPTS,text+'\n');if(process.env.MAIL_PAUSE_RECEIPT==='1')return}if(text.includes('[Slack ')){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'slack_message_draft',arguments:{text:'Fixture Slack reply',thread_ts:'123.456'}}})});const result=await response.json();if(!response.ok||result.error||result.result?.isError)throw Error('draft rejected')}send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:'Draft handled'}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}}catch(e){fs.appendFileSync(process.env.MAIL_RECEIPTS,'error:'+e.message+'\n')}})
`);await fs.chmod(fake,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','slack_message_draft'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});let logs=''
let pauseReceipt=false
function launch(){const p=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,NODE_OPTIONS:`--require=${mock}`,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,MAIL_TRACE:trace,MAIL_MODE:mode,MAIL_RECEIPTS:receipts,MAIL_DEBUG:path.join(root,'debug'),SLACK_EVENTS:events,SLACK_ACKS:acks,MAIL_PAUSE_RECEIPT:pauseReceipt?'1':'0'},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function connect(){let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1200));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw Error('timeout '+expression+' logs '+logs.slice(-1000))}
async function stop(){ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function prompt(text){await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)}
const event=(id,user='U123',channel='C123')=>({type:'events_api',envelope_id:'env-'+id,payload:{type:'event_callback',team_id:'T123',event_id:id,event:{type:'message',user,channel,ts:'123.456',text:'Fixture incoming message '+id}}})
async function push(value){await fs.appendFile(events,JSON.stringify(value)+'\n')}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 await push(event('EvIgnored','UOTHER'));await push(event('Ev123'));await push({...event('Ev123'),envelope_id:'env-duplicate'})
 await wait(`document.querySelector('[aria-label="Slack 消息草稿"]')?.innerText.includes('Fixture Slack reply')`,45000)
 await delay(400);const ackLines=(await fs.readFile(acks,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(ackLines.some(x=>x.envelope_id==='env-EvIgnored'));assert.ok(ackLines.some(x=>x.envelope_id==='env-Ev123'));assert.ok(ackLines.some(x=>x.envelope_id==='env-duplicate'))
 assert.equal(await fs.readFile(trace,'utf8').catch(()=>''),'','draft must not send without user action')
 const messages=await evaluate(`window.openbot.bots.list().then(bs=>window.openbot.sessions.get(bs[0].activeConversationId))`)
 assert.equal(JSON.stringify(messages).split('Fixture incoming message').length-1,1,'duplicate Slack event must yield one message')
 await evaluate(`[...document.querySelectorAll('[aria-label="Slack 消息草稿"] button')].find(b=>b.textContent.includes('确认发送')).click()`)
 await wait(`document.querySelector('[aria-label="Slack 消息草稿"]')?.innerText.includes('Slack 消息已发送')`)
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.slackDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.some(d=>d.feedbackStatus==='delivered'))`,45000)
 assert.match(await fs.readFile(receipts,'utf8'),/"status":"sent"/)
 const post=new URLSearchParams((await fs.readFile(trace,'utf8')).trim());assert.equal(post.get('channel'),'C123');assert.equal(post.get('thread_ts'),'123.456');assert.equal(post.get('text'),'Fixture Slack reply')
 await fs.writeFile(mode,'failure');await push(event('EvFailure'))
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]').length===2`,45000)
 await evaluate(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[1].querySelectorAll('button')[1].click()`)
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[1]?.innerText.includes('发送结果未确认')`)
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.slackDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.filter(d=>d.feedbackStatus==='delivered').length===2)`,45000)
 await fs.writeFile(mode,'hang');await push(event('EvInterrupted'))
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]').length===3`,45000)
 const interruptedId=await evaluate(`window.openbot.bots.list().then(bs=>window.openbot.slackDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts[2].id)`)
 await evaluate(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[2].querySelectorAll('button')[1].click()`)
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[2]?.innerText.includes('正在发送')`)
 await delay(200);app.kill('SIGKILL');await new Promise(resolve=>app.once('exit',resolve));ws.close();await delay(300);pauseReceipt=true;app=launch();await connect();await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]').length===3`)
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[2]?.innerText.includes('发送结果未确认')`)
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.slackDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.some(d=>d.id===${JSON.stringify(interruptedId)}&&d.feedbackStatus==='delivering'))`,45000)
 await delay(300);app.kill('SIGKILL');await new Promise(resolve=>app.once('exit',resolve));ws.close();await delay(300);pauseReceipt=false;app=launch();await connect();await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]').length===3`)
 await wait(`document.querySelectorAll('[aria-label="Slack 消息草稿"]')[2]?.innerText.includes('Bot 是否处理这条结果尚未确认')`)
 await delay(800);assert.equal((await fs.readFile(trace,'utf8')).trim().split('\n').length,3);assert.equal((await fs.readFile(receipts,'utf8')).split(interruptedId).length-1,1,'interrupted receipt must not be replayed')
 console.log(JSON.stringify({realElectron:true,slackAndCodexMocked:true,encryptedAtRest:true,authorizedEvent:true,scopedInput:true,deduplication:true,userConfirmation:true,oneSend:true,botReceipt:true,uncertainNotRetried:true,crashNotRetried:true,feedbackCrashNotRetried:true}))
}finally{await stop();await fs.rm(root,{recursive:true,force:true});await fs.rm(helperDir,{recursive:true,force:true})}
