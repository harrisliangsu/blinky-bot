/** Actual Electron + installed pi 0.84.1; model decisions are scripted loopback SSE. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {spawn} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {createPiFixture} from './piFixture.mjs'
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-pi-electron-'))
const data=path.join(root,'data'),evidence=path.resolve('docs/test-evidence/pi-delegation-20261106')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(evidence,{recursive:true})
const fixture=await createPiFixture(root)
const backends=Object.fromEntries(['codex','claude','opencode','kimi','grok','droid','openai','anthropic','openrouter','xai','ollama','lmstudio'].map(id=>[id,{enabled:false}]))
backends.pi={enabled:true,command:fixture.wrapper,extraArgs:[]}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'dark',language:'en',vibrant:false,defaultBackendId:'pi',defaultModelId:'fixture/lead-model',defaultMode:'agent',approvalPolicy:'auto-run',memoryExtraction:'off',backends}))
const original={id:'blinky',name:'Blinky',systemPrompt:'Synthetic acceptance only.',emoji:'B',color:'#999999',backendId:'pi',modelId:'fixture/lead-model',thinking:'low',followsDefault:false,executionAgentDisabled:true,executionAgent:{backendId:'pi',modelId:'fixture/worker-model',thinking:'high'},tools:['delegate_task','read_file','write_file'],skills:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify(original))
const frame=(name,args)=>({text:'<openbot_tool_call>'+JSON.stringify({name,arguments:args})+'</openbot_tool_call>'})
let holdWorker=false
fixture.setResponse(body=>{
 const asText=value=>typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):''
 const sys=body.messages.filter(m=>m.role==='system').map(m=>asText(m.content)).join('\n')
 if(body.model==='worker-model')return holdWorker?{hold:true}:{text:'Synthetic worker result'}
 if(!sys.includes('# BlinkyBot tool-call protocol'))return {text:'Synthetic title'}
 const prompt=asText(body.messages.at(-1).content)
 if(prompt.includes('<agent_result>')){
  if(/Tool result \(review_task\):/.test(prompt.slice(prompt.lastIndexOf('<agent_result>'))))return {text:'Synthetic reviewed result'}
  const matches=[...prompt.matchAll(/<agent_result>(.*?)<\/agent_result>/gs)]
  if(matches.length){const info=JSON.parse(matches.at(-1)[1]);return frame('review_task',{task_id:info.taskId,outcome:'complete_claimed',summary:'Synthetic result checked',evidence:['The isolated worker returned its synthetic response.']})}
 }
 const marker=[...prompt.matchAll(/__PI_[A-Z_]+__/g)].at(-1)?.[0]
 if(marker==='__PI_HOLD__')return {hold:true}
 if(marker==='__PI_DELEGATE__')return prompt.includes('Tool result (delegate_task):')?{text:'Synthetic delegated acknowledgement'}:frame('delegate_task',{prompt:'Synthetic background task only',title:'pi isolated delegation'})
 if(['__PI_REJECT__','__PI_APPROVE__','__PI_STOP_APPROVAL__','__PI_ASK__','__PI_DENYLIST__'].includes(marker))return prompt.includes('Tool result (write_file):')?{text:'Synthetic write result received'}:frame('write_file',{path:path.join(root,'approved-fixture.txt'),content:'temporary fixture only'})
 return {text:'Simple pi response'}
})
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=await fs.realpath(path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
let app,ws,seq=0,logs='',home;const pending=new Map()
function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,PI_CODING_AGENT_DIR:fixture.configDir,PI_OFFLINE:'1',PI_TELEMETRY:'0'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},30000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression,ms=45000){const until=Date.now()+ms;while(Date.now()<until){if(await evaluate(expression))return;await delay(100)}throw Error('Timeout '+expression+'\n'+logs.slice(-1800))}
async function nodeWait(predicate,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(predicate())return;await delay(60)}throw Error('Node wait timeout')}
async function connect(){let target;for(let i=0;i<350;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');if(target)break}catch{}await delay(100)}if(!target)throw Error('No renderer '+logs.slice(-2000));ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function stopApp(){ws?.close();if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),delay(4000)]);if(app.exitCode===null&&app.signalCode===null){app.kill('SIGKILL');await delay(300)}}}
const bot=()=>evaluate("window.openbot.bots.get('blinky')")
const idle=()=>wait(`window.openbot.agent.isRunning(${JSON.stringify(home)}).then(v=>!v)`)
async function send(text){await idle();assert.equal(await evaluate(`window.openbot.agent.send(${JSON.stringify(home)},${JSON.stringify(text)})`),true)}
async function clear(){await idle();await evaluate(`window.openbot.sessions.clear(${JSON.stringify(home)})`)}
const result={realElectron:true,realPi:true,piVersion:'0.84.1',realModel:false,localProvider:true}
try{
 app=launch();await connect();await wait("!!document.querySelector('#ob-prompt')")
 await wait("window.openbot.backends.list().then(a=>a.some(b=>b.id==='pi'&&b.status==='available'))")
 home=(await bot()).activeConversationId;await evaluate(`window.openbot.sessions.setCwd(${JSON.stringify(home)},${JSON.stringify(root)})`)
 assert.equal((await bot()).executionAgentDisabled,undefined)
 const before=(await evaluate('window.openbot.tasks.list()')).length
 await send('__PI_SIMPLE__');await idle();assert.equal((await evaluate('window.openbot.tasks.list()')).length,before)
 assert.ok((await evaluate(`window.openbot.sessions.get(${JSON.stringify(home)})`)).messages.some(m=>m.content==='Simple pi response'))
 result.simpleDirect=true
 await clear();await send('__PI_DELEGATE__');await idle()
 await wait("window.openbot.tasks.list().then(a=>a.some(t=>t.title==='pi isolated delegation'&&t.status==='completed'&&t.review))",60000)
 const delegated=(await evaluate('window.openbot.tasks.list()')).find(t=>t.title==='pi isolated delegation')
 assert.deepEqual(delegated.executionAgent,original.executionAgent);assert.equal(delegated.review.outcome,'complete_claimed')
 assert.ok(fixture.requests.some(r=>r.body.model==='lead-model'&&r.body.reasoning_effort==='low'))
 assert.ok(fixture.requests.some(r=>r.body.model==='worker-model'&&r.body.reasoning_effort==='high'))
 result.legacyDelegationAndReview=true;result.independentModels=true
 await idle();await clear();await evaluate("window.openbot.settings.update({approvalPolicy:'ask-every-time'})")
 await send('__PI_REJECT__');await wait("!!document.querySelector('.ob-approval')")
 assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false)
 await delay(500);await evaluate("document.querySelector('.ob-approval .ob-btn-danger').click()")
 await idle();await delay(350);assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false)
 result.rejectedWriteStopped=true
 await clear();await send('__PI_APPROVE__');await wait("!!document.querySelector('.ob-approval')")
 assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false)
 await delay(500);await evaluate("document.querySelector('.ob-approval .ob-btn-primary').click()")
 await idle();assert.equal(await fs.readFile(path.join(root,'approved-fixture.txt'),'utf8'),'temporary fixture only')
 result.writeOnlyAfterApproval=true
 await fs.rm(path.join(root,'approved-fixture.txt'));await clear();await send('__PI_STOP_APPROVAL__');await wait("!!document.querySelector('.ob-approval')")
 assert.equal(await evaluate(`window.openbot.agent.stop(${JSON.stringify(home)})`),true);await idle()
 await wait("!document.querySelector('.ob-approval')");assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false)
 result.stopClearsApproval=true
 await clear();await evaluate(`window.openbot.sessions.setMode(${JSON.stringify(home)},'ask')`)
 await send('__PI_ASK__');await idle();assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false)
 assert.equal(await evaluate("!!document.querySelector('.ob-approval')"),false)
 const last=fixture.requests.at(-1).body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')
 assert.ok(!last.includes('"name":"write_file"')&&!last.includes('"name":"delegate_task"'));result.askModeNoMutators=true
 await evaluate(`window.openbot.sessions.setMode(${JSON.stringify(home)},'agent')`);await clear()
 await evaluate("window.openbot.settings.update({approvalPolicy:'auto-run',denylist:['tool:write_file']})")
 await send('__PI_DENYLIST__');await idle();assert.equal(await fs.access(path.join(root,'approved-fixture.txt')).then(()=>true,()=>false),false);result.denylistEnforced=true
 await clear();await evaluate("window.openbot.settings.update({denylist:[]})")
 const count=fixture.requests.length;await send('__PI_HOLD__');await nodeWait(()=>fixture.requests.length>count&&JSON.stringify(fixture.requests.at(-1).body.messages.at(-1).content).includes('__PI_HOLD__'))
 const held=fixture.requests.at(-1),at=Date.now();assert.equal(await evaluate(`window.openbot.agent.stop(${JSON.stringify(home)})`),true)
 await idle();await nodeWait(()=>held.closed,6000);result.stopMs=Date.now()-at
 await clear();holdWorker=true
 const task=await evaluate("window.openbot.tasks.create('blinky','Synthetic cancellation only','pi cancellation')")
 assert.ok(task?.id);await nodeWait(()=>fixture.requests.some(r=>r.body.model==='worker-model'&&!r.closed))
 const worker=fixture.requests.findLast(r=>r.body.model==='worker-model'&&!r.closed)
 await send('__PI_SIMPLE__');await idle();assert.equal(await evaluate(`window.openbot.agent.isRunning(${JSON.stringify(task.sessionId)})`),true)
 await evaluate(`window.openbot.tasks.cancel(${JSON.stringify(task.id)})`)
 await wait(`window.openbot.tasks.list().then(a=>a.some(t=>t.id===${JSON.stringify(task.id)}&&t.status==='cancelled'))`)
 await nodeWait(()=>worker.closed,6000);holdWorker=false;result.workerCancellationAndChatAvailable=true
 await idle();await stopApp();app=launch();await connect();await wait("!!document.querySelector('#ob-prompt')")
 const saved=await bot();assert.equal(saved.modelId,original.modelId);assert.equal(saved.thinking,original.thinking);assert.deepEqual(saved.executionAgent,original.executionAgent);result.restartReadback=true
 const calls=(await fs.readFile(fixture.trace,'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.mode==='json')
 assert.ok(calls.length>4&&calls.every(r=>r.noTools&&r.noExtensions));assert.ok(fixture.requests.every(r=>!r.body.tools?.length));result.noNativeTools=true
 const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'pi-electron.png'),Buffer.from(shot.data,'base64'))
 result.providerRequests=fixture.requests.length;result.dataRoot=root
 await fs.writeFile(path.join(evidence,'electron-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}catch(error){await fs.writeFile(path.join(evidence,'electron-failure.json'),JSON.stringify({error:String(error),root,requests:fixture.requests.map(r=>({model:r.body.model,closed:r.closed,prompt:r.body.messages.at(-1)?.content?.slice(-1500)}))},null,2));throw error}
finally{await stopApp();await fixture.close();await fs.writeFile(path.join(evidence,'electron.log'),logs)}
