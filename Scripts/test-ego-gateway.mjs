/** Packaged app -> fake Codex MCP -> actual Ego browser, with isolated data and a local page. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const bundle = process.env.BLINKY_TEST_APP_BUNDLE
if (!bundle) throw Error('BLINKY_TEST_APP_BUNDLE is required')
const real = process.env.BLINKY_REAL_EGO === '1'
const rejectNavigation = process.env.BLINKY_EGO_REJECT === '1'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-ego-gateway-'))
const data = path.join(root, 'data'), fake = path.join(root, 'codex'), trace = path.join(root, 'trace')
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
let visits=0
const fixture = http.createServer((_req, res) => { visits++;res.end('<!doctype html><title>Isolated browser fixture</title><h1>Fixture</h1>') })
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${fixture.address().port}/`
await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const line=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',endpoint=line.match(/url="([^"]+)"/)?.[1],token=line.match(/bearer_token_env_var="([^"]+)"/)?.[1],send=x=>process.stdout.write(JSON.stringify(x)+'\n'),parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();
async function call(name,args){const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const j=await r.json();if(!r.ok||j.error||j.result?.isError)throw Error(JSON.stringify(j));if(!j.result?.content?.some(x=>x.type==='image'&&x.data?.length>100))throw Error('missing image');fs.appendFileSync(process.env.EGO_TRACE,name+'\n')}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'test-model',displayName:'Test'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'test-thread'}}});else if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'t1'}}});send({method:'turn/started',params:{turn:{id:'t1'},threadId:'test-thread'}});if(endpoint){await call('navigate',{url:process.env.EGO_FIXTURE_URL});await call('screenshot',{})}send({method:'item/started',params:{item:{type:'agentMessage',id:'m1',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m1',delta:endpoint?'browser fixture checked':'[]'}});send({method:'turn/completed',params:{turn:{id:'t1',status:'completed',items:[]}}})}}catch(e){fs.appendFileSync(process.env.EGO_TRACE,'error:'+e.message+'\n')}})
`)
await fs.chmod(fake, 0o700)
const model = real ? 'default' : 'test-model'
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:model,defaultMode:'agent',approvalPolicy:'auto-run',computerUseAllowedApps:['127.0.0.1'],backends:{codex:{enabled:true,command:real?'codex':fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:model,followsDefault:false,tools:['navigate','screenshot'],computerUse:true,computerTarget:{kind:'browser',botId:'blinky',provider:'ego'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const executable=path.join(bundle,'Contents/MacOS/BlinkyBot Preview')
let logs='';const app=spawn(executable,[`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,EGO_TRACE:trace,EGO_FIXTURE_URL:url},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws, seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
try {
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1000))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 for(let i=0;i<300&&!await evaluate(`!!document.querySelector('#ob-prompt')`);i++)await delay(100)
 await evaluate(`window.__egoTestEvents=[];window.__egoTestOff=window.openbot.on(e=>{if(e.type==='tool-result'&&['navigate','screenshot'].includes(e.result.name))window.__egoTestEvents.push({name:e.result.name,ok:e.result.ok,hasImage:!!e.result.screenshot})})`)
 const prompt=real?`Use the supplied BlinkyBot MCP computer tools to inspect ${url}. First call navigate for that URL, then call screenshot. The browser begins on a blank page and screenshot is disallowed until you navigate. Do not use shell, a different browser, or any other site. Then reply briefly.`:'Check the isolated browser fixture.'
 await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(prompt)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 async function decide(label){for(let i=0;i<450&&!await evaluate(`!!document.querySelector('.ob-approval')`);i++)await delay(100);assert.ok(await evaluate(`!!document.querySelector('.ob-approval')`),'computer action did not request approval');await delay(600);await evaluate(`[...document.querySelectorAll('.ob-approval button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);for(let i=0;i<100&&await evaluate(`!!document.querySelector('.ob-approval')`);i++)await delay(100)}
 if(rejectNavigation){
  await decide('拒绝');await delay(500);assert.equal(visits,0,'denied navigation must not reach the fixture')
  console.log(JSON.stringify({packagedGateway:true,realEgo:true,navigationRequiredApproval:true,rejectedNavigationNotExecuted:true}))
 }else{
 await decide('允许')
 await decide('允许')
 const deadline=Date.now()+90000;while(Date.now()<deadline){const events=await evaluate('window.__egoTestEvents');if(events.some(e=>e.name==='navigate'&&e.ok&&e.hasImage)&&events.some(e=>e.name==='screenshot'&&e.ok&&e.hasImage))break;const t=await fs.readFile(trace,'utf8').catch(()=>'');if(t.includes('error:'))throw Error(t);await delay(200)}
 const events=await evaluate('window.__egoTestEvents');assert.ok(events.some(e=>e.name==='navigate'&&e.ok&&e.hasImage)&&events.some(e=>e.name==='screenshot'&&e.ok&&e.hasImage),'missing successful image tool results')
 if(!real)assert.deepEqual((await fs.readFile(trace,'utf8')).trim().split('\n'),['navigate','screenshot'])
 console.log(JSON.stringify({packagedGateway:true,realEgo:true,realCodex:real,localNavigation:true,screenshotReturned:true}))
 }
} finally {
 ws?.close();app.kill('SIGTERM');await delay(1000);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');fixture.closeAllConnections();fixture.close()
 const space=await fs.readFile(path.join(data,'computers','blinky','ego-space.json'),'utf8').then(JSON.parse).catch(()=>null)
 if(Number.isSafeInteger(space?.id))await new Promise(resolve=>{const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','ignore','ignore']});child.on('error',resolve);child.on('close',resolve);child.stdin.end(`const task=await taskSpace(${space.id});if(task.name===${JSON.stringify(space.name)})await task.finish({keep:false});`)})
 await fs.rm(root,{recursive:true,force:true})
}
