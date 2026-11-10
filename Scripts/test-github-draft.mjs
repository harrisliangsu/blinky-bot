/** Isolated Electron + fake CLI: no network write or user's GitHub credentials. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-draft-'))
const data = path.join(root, 'data'), bin = path.join(root, 'bin'), trace = path.join(root, 'sent'), botTrace = path.join(root, 'bot-receipts')
await fs.mkdir(path.join(data, 'bots'), { recursive: true }); await fs.mkdir(bin)
const shell = path.join(root, 'shell'), codex = path.join(bin, 'codex'), gh = path.join(bin, 'gh')
await fs.writeFile(shell, `#!/bin/sh\nprintf '__openbot_env__\\nPATH=${bin}:/usr/bin:/bin\\nHOME=${root}\\n'\n`)
await fs.writeFile(gh, `#!${process.execPath}\nconst fs=require('fs');let body='';process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>{fs.appendFileSync(process.env.DRAFT_TRACE,JSON.stringify({args:process.argv.slice(2),body})+'\\n');if(process.argv.join(' ').includes('/13/'))process.exit(1);if(process.argv.join(' ').includes('/14/')){const parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100);return}console.log(JSON.stringify({id:42,html_url:'https://github.com/example/project/issues/12#issuecomment-42'}))})\n`)
await fs.writeFile(codex, `#!${process.execPath}\n` + String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],token=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');const parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();
readline.createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'draft-test'}}});else if(r.method==='turn/start'){const turn='t'+(++n),text=r.params.input[0].text;send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'draft-test'}});if(text.includes('<github_receipt>')){fs.appendFileSync(process.env.DRAFT_BOT_TRACE,text+'\n');if(process.env.DRAFT_PAUSE_RECEIPT==='1'&&text.includes('example/project#14'))return}if(text.includes('CREATE_DRAFT')){const num=text.includes('CRASH')?14:text.includes('UNCERTAIN')?13:12;const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'github_comment_draft',arguments:{owner:'example',repo:'project',issue_number:num,body:'A test comment'}}})});const result=await reply.json();if(!reply.ok||result.error||result.result?.isError)throw Error('draft failed '+JSON.stringify(result))}send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:'Draft prepared'}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}});
`)
for (const f of [shell, codex, gh]) await fs.chmod(f, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',backends:{codex:{enabled:true,command:codex,extraArgs:[]}} }))
await fs.writeFile(path.join(data, 'bots', 'blinky.json'), JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task','github_comment_draft'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
let pauseReceipt=false
function launch(){const p=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,HOME:root,SHELL:shell,PATH:`${bin}:/usr/bin:/bin`,GH_TOKEN:'',GITHUB_TOKEN:'',BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,DRAFT_TRACE:trace,DRAFT_BOT_TRACE:botTrace,DRAFT_PAUSE_RECEIPT:pauseReceipt?'1':'0'},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const value=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value}
async function connect(){let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1200));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw Error('timeout '+expression+' drafts '+await fs.readFile(path.join(data,'github-comment-drafts.json'),'utf8').catch(()=>'missing')+' botTrace '+await fs.readFile(botTrace,'utf8').catch(()=>'missing')+' logs '+logs.slice(-2000))}
async function stop(){ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function sendPrompt(text){await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`);await sendPrompt('CREATE_DRAFT')
 await wait(`document.querySelector('.ob-github-draft')?.innerText.includes('example/project')`,45000)
 assert.equal(await fs.readFile(trace,'utf8').catch(()=>''),'', 'draft creation must not send')
 let records=JSON.parse(await fs.readFile(path.join(data,'github-comment-drafts.json'),'utf8'));assert.equal(records[0].status,'draft')
 await evaluate(`[...document.querySelectorAll('.ob-github-draft button')].find(x=>x.textContent.includes('确认发送')).click()`)
 await wait(`document.querySelector('.ob-github-draft')?.innerText.includes('已发送')`)
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.githubDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.some(d=>d.issueNumber===12&&d.feedbackStatus==='delivered'))`,45000)
 assert.match(await fs.readFile(botTrace,'utf8'),/"status":"sent"/)
 let sent=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0].body).body,'A test comment')
 await sendPrompt('CREATE_DRAFT UNCERTAIN');await wait(`document.querySelectorAll('.ob-github-draft').length===2`,45000)
 await evaluate(`[...document.querySelectorAll('.ob-github-draft')].find(x=>x.innerText.includes('#13')).querySelectorAll('button')[1].click()`)
 await wait(`[...document.querySelectorAll('.ob-github-draft')].some(x=>x.innerText.includes('发送结果未确认'))`)
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.githubDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.some(d=>d.issueNumber===13&&d.feedbackStatus==='delivered'))`,45000)
 assert.match(await fs.readFile(botTrace,'utf8'),/"status":"uncertain"/)
 records=JSON.parse(await fs.readFile(path.join(data,'github-comment-drafts.json'),'utf8'));assert.deepEqual(records.map(d=>d.status),['sent','uncertain'])
 await sendPrompt('CREATE_DRAFT CRASH');await wait(`document.querySelectorAll('.ob-github-draft').length===3`,45000)
 await evaluate(`[...document.querySelectorAll('.ob-github-draft')].find(x=>x.innerText.includes('#14')).querySelectorAll('button')[1].click()`)
 await wait(`[...document.querySelectorAll('.ob-github-draft')].find(x=>x.innerText.includes('#14'))?.innerText.includes('正在发送')`)
 await delay(300);app.kill('SIGKILL');await new Promise(resolve=>app.once('exit',resolve));ws.close();await delay(300);pauseReceipt=true;app=launch();await connect();await wait(`document.querySelectorAll('.ob-github-draft').length===3`)
 assert.ok(await evaluate(`[...document.querySelectorAll('.ob-github-draft')].find(x=>x.innerText.includes('#14'))?.innerText.includes('发送结果未确认')`))
 await wait(`window.openbot.bots.list().then(bs=>window.openbot.githubDrafts.list(bs[0].activeConversationId)).then(r=>r.drafts?.some(d=>d.issueNumber===14&&d.feedbackStatus==='delivering'))`,45000)
 await delay(500);app.kill('SIGKILL');await new Promise(resolve=>app.once('exit',resolve));ws.close();await delay(300);pauseReceipt=false;app=launch();await connect();await wait(`document.querySelectorAll('.ob-github-draft').length===3`)
 await wait(`[...document.querySelectorAll('.ob-github-draft')].find(x=>x.innerText.includes('#14'))?.innerText.includes('Bot 是否处理了这条结果尚未确认')`)
 await delay(500);assert.equal((await fs.readFile(botTrace,'utf8')).split('example/project#14').length-1,1)
 assert.equal((await fs.readFile(trace,'utf8')).trim().split('\n').length,3)
 console.log(JSON.stringify({draftPersisted:true,userActionRequired:true,receiptPersisted:true,botReceivesReceipts:true,uncertainNotRetried:true,sendCrashNotRetried:true,feedbackCrashNotRetried:true,restartReadback:true}))
} finally {await stop();await fs.rm(root,{recursive:true,force:true})}
