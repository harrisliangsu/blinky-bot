/** Real isolated Electron + fake Codex/Grok. Never uses a real model/account. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
if (process.platform !== 'darwin') throw Error('macOS Electron is required')
const repo = process.cwd()
const root = process.env.BLINKY_DETAILS_TEST_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-details-'))
await fs.mkdir(root, { recursive: true })
const data = path.join(root, 'data'), trace = path.join(root, 'trace.jsonl')
const evidence = path.resolve(process.env.BLINKY_DETAILS_EVIDENCE || 'docs/test-evidence/bot-details-20261106')
await fs.mkdir(path.join(data, 'bots'), { recursive: true });
// Fresh fake native bindings on each run; keep the owned browser record.
await fs.rm(path.join(data, 'provider-bindings.json'), { force: true }); await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(trace, '')
const fake = path.join(root, 'fake-codex.cjs'), grok = path.join(root, 'fake-grok.cjs')
await fs.writeFile(fake, String.raw`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline'),args=process.argv.slice(2),send=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
const cfg=args.find(a=>a.startsWith('mcp_servers.openbot='))||'',url=cfg.match(/url="([^"]+)"/)?.[1],tokenName=cfg.match(/bearer_token_env_var="([^"]+)"/)?.[1];let n=0,model='';
const record=x=>fs.appendFileSync(process.env.BLINKY_DETAILS_TRACE,JSON.stringify(x)+'\n');
const rpc=async(name,arguments_)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:arguments_}})});const v=await r.json();if(!r.ok||v.error||v.result?.isError)throw Error('fixture gateway rejected '+name);return v};
rl.createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);try{
if(r.method==='initialize')send({id:r.id,result:{}});
else if(r.method==='model/list')send({id:r.id,result:{data:['lead-model','other-model','worker-model'].map((m,i)=>({model:m,displayName:m,isDefault:i===0,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]})),nextCursor:null}});
else if(r.method==='thread/start'||r.method==='thread/resume'){model=r.params.model||model;send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'fixture-'+model+'-'+process.pid}}})}
else if(r.method==='turn/start'){
 const id='turn-'+(++n),text=r.params.input.map(x=>x.text||'').join('\n');model=r.params.model||model;
 record({kind:url?'codex':'side-call',model,effort:r.params.effort,hasGlobalSkill:text.includes('aaa-details-global-skill'),simple:text.trim().endsWith('__SIMPLE__'),complex:text.trim().endsWith('__DELEGATE__')});
 send({id:r.id,result:{turn:{id}}});send({method:'turn/started',params:{threadId:'fixture-'+model+'-'+process.pid,turn:{id}}});let answer='Simple fixture reply';
 if(!url)answer='Fixture title';
 else if(model==='worker-model')answer='Worker fixture result';
 else if(text.includes('<agent_result>')&&!text.trim().endsWith('__SIMPLE__')&&!text.trim().endsWith('__DELEGATE__')){const m=[...text.matchAll(/<agent_result>(.*?)<\/agent_result>/gs)].at(-1);if(m){const d=JSON.parse(m[1]);await rpc('review_task',{task_id:d.taskId,outcome:'complete_claimed',summary:'Fixture reviewed',evidence:['Synthetic worker returned its expected result']});answer='Reviewed fixture result'}}
 else if(text.trim().endsWith('__DELEGATE__')){await rpc('delegate_task',{prompt:'Synthetic multi-step work',title:'Legacy switch delegation'});answer='Delegated fixture work'}
 send({method:'item/started',params:{item:{id:'item-'+id,type:'agentMessage',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'item-'+id,delta:answer}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id,status:'completed',items:[]}}}),25)
}
}catch(e){record({error:e.message});process.exitCode=1}})
`)
await fs.writeFile(grok, String.raw`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline'),send=x=>process.stdout.write(JSON.stringify(x)+'\n'),args=process.argv.slice(2);let server,model='grok-fixture';
if(args.includes('version')||args.includes('--version')){console.log('Grok CLI 1.0.0');process.exit(0)}if(args.includes('models')){console.log('Available models:\n* grok-fixture (default)');process.exit(0)}
const record=x=>fs.appendFileSync(process.env.BLINKY_DETAILS_TRACE,JSON.stringify(x)+'\n');
rl.createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);try{
if(r.method==='initialize')send({id:r.id,result:{authMethods:[{id:'xai.api_key'},{id:'cached_token'}],agentCapabilities:{mcpCapabilities:{http:true}}}});
else if(r.method==='authenticate')send({id:r.id,result:{}});
else if(r.method==='session/new'||r.method==='session/load'){server=r.params.mcpServers.find(s=>s.name==='openbot');fs.writeFileSync(process.env.BLINKY_GROK_POLICY_MARKER,JSON.stringify({event:'session_start',mode:'default',sessionId:'grok-fixture-session'}));send({id:r.id,result:{sessionId:'grok-fixture-session'}})}
else if(r.method==='session/set_config_option'){if(r.params.configId==='model')model=r.params.value;send({id:r.id,result:{configOptions:[{id:r.params.configId,currentValue:r.params.value}]}})}
else if(r.method==='session/prompt'){
 const text=r.params.prompt.map(x=>x.text||'').join('\n');record({kind:'grok',model,hasGateway:!!server,hasDelegationInstructions:text.includes('# Independent execution agent')});let answer='Grok fixture reply';
 if(text.trim().endsWith('__GROK_DELEGATE__')){if(!server||!/^http:\/\/127\.0\.0\.1:/.test(server.url))throw Error('missing local gateway');const response=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'delegate_task',arguments:{prompt:'Synthetic Grok delegated work',title:'Grok delegation'}}})});const v=await response.json();if(!response.ok||v.error||v.result?.isError)throw Error('Grok delegation rejected');answer='Grok fixture delegated'}
 send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});send({id:r.id,result:{stopReason:'end_turn'}})
}
}catch(e){record({error:e.message});process.exitCode=1}})
`)
await fs.chmod(fake, 0o700); await fs.chmod(grok, 0o700)
const backends = Object.fromEntries(['claude','opencode','kimi','pi','droid','openai','anthropic','openrouter','xai','ollama','lmstudio'].map(id => [id, { enabled: false }]))
backends.codex = { enabled: true, command: fake, extraArgs: [] }
backends.grok = { enabled: true, command: grok, extraArgs: [], apiKey: 'fixture-only-not-a-real-key' }
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme:'dark',language:'zh-CN',vibrant:false,defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',memoryExtraction:'off',backends }))
const original = { id:'blinky',name:'Blinky',systemPrompt:'Synthetic test only',emoji:'B',color:'#999999',backendId:'codex',modelId:'lead-model',thinking:'low',followsDefault:false,executionAgentDisabled:true,executionAgent:{backendId:'codex',modelId:'worker-model',thinking:'high'},tools:['delegate_task'],skills:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1 }
await fs.writeFile(path.join(data, 'bots', 'blinky.json'), JSON.stringify(original))
await fs.writeFile(path.join(data, 'bots', 'legacy-empty.json'), JSON.stringify({ ...original,id:'legacy-empty',name:'Legacy Empty',executionAgent:undefined,createdAt:2 }))
await fs.writeFile(path.join(data, 'bots', 'legacy-vm.json'), JSON.stringify({ ...original,id:'legacy-vm',name:'Legacy VM',computerTarget:{kind:'vm',vmId:'offline-fixture',endpoint:'http://127.0.0.1:9'},createdAt:3 }))
await fs.mkdir(path.join(root,'.agents','skills','aaa-details-global-skill'), { recursive: true })
await fs.writeFile(path.join(root,'.agents','skills','aaa-details-global-skill','SKILL.md'),'---\nname: aaa-details-global-skill\ndescription: Synthetic globally visible skill for acceptance.\n---\nDo not execute anything.\n')
const port = await new Promise((resolve,reject)=>{ const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))}) })
const electron = path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let logs='', app, ws, seq=0; const pending=new Map()
function launch() { const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,BLINKY_DETAILS_TRACE:trace},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child }
function cmd(method,params={}) { const id=++seq;return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},60000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params})) }) }
async function evaluate(expression) { const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error('Renderer: '+JSON.stringify(v.exceptionDetails));return v.result.value }
async function wait(expression,ms=30000) { const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(80)}throw Error('Timeout: '+expression+'\n'+logs.slice(-1800)) }
async function connect() {let targets;for(let i=0;i<350;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('Electron did not expose a renderer\n'+logs.slice(-2000));ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}} }
async function stop() { ws?.close();if(!app||app.exitCode!==null||app.signalCode!==null)return;app.kill('SIGTERM');await Promise.race([new Promise(resolve=>app.once('exit',resolve)),delay(4000)]);if(app.exitCode===null&&app.signalCode===null){app.kill('SIGKILL');await delay(300)} }
const rows = async()=> (await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const bot = () => evaluate(`window.openbot.bots.get('blinky')`)
let home
async function idle() { await wait(`!window.openbot.agent.isRunning || window.openbot.agent.isRunning(${JSON.stringify(home)}).then(v=>!v)`);await delay(200) }
async function send(text) {await idle();await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);await delay(100);await idle() }
async function pick(section,label,value) {const selector=JSON.stringify(`#ob-bot-details section[aria-label="${section}"] select[aria-label="${label}"]`);await wait(`Array.from(document.querySelector(${selector})?.options??[]).some(o=>o.value===${JSON.stringify(value)})`);await evaluate(`(()=>{const e=document.querySelector(${selector});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await wait(`document.querySelector(${selector})?.value===${JSON.stringify(value)}`) }
const escape=()=>cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
async function shot(name) {const s=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64')) }
const runStartedAt=Date.now()
const result={realElectron:true,realModel:false,fakeCodex:true,fakeGrok:true}
try {
 app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 await wait(`window.openbot.backends.list().then(a=>['codex','grok'].every(id=>a.some(b=>b.id===id&&b.status==='available')))`,45000)
 home=(await bot()).activeConversationId;await evaluate(`window.openbot.sessions.setCwd(${JSON.stringify(home)},${JSON.stringify(root)})`)
 assert.equal((await bot()).executionAgentDisabled,undefined)
 const empty=await evaluate(`window.openbot.bots.get('legacy-empty')`);assert.deepEqual(empty.executionAgent,{backendId:'codex',modelId:'lead-model',thinking:'low'});result.legacyMigration=true
 const before=(await evaluate('window.openbot.tasks.list()')).length
 await send('__SIMPLE__');assert.equal((await evaluate('window.openbot.tasks.list()')).length,before);assert.ok((await rows()).some(r=>r.simple&&r.hasGlobalSkill));result.simpleDirect=true;result.unassignedGlobalSkill=true
 await send('__DELEGATE__');await wait(`window.openbot.tasks.list().then(a=>a.some(t=>t.title==='Legacy switch delegation'&&t.createdAt>=${runStartedAt}&&t.status==='completed'))`)
 assert.ok((await rows()).some(r=>r.model==='worker-model'&&r.effort==='high'));result.legacyDelegation=true
 await evaluate(`document.querySelector('.ob-header-bot-trigger').click()`);await wait(`!!document.querySelector('#ob-bot-details')`)
 const text=await evaluate(`document.querySelector('#ob-bot-details').innerText`);assert.doesNotMatch(text,/工具权限|虚拟机|启用独立执行 Agent|已选择.*项/)
 assert.equal(await evaluate(`document.querySelectorAll('#ob-bot-details .ob-bot-runtime-grid select').length`),6)
 await pick('对话模型','模型','other-model');await pick('对话模型','思考深度','high')
 await pick('执行 Agent','模型','lead-model');await pick('执行 Agent','思考深度','low')
 await evaluate(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`)
 await wait(`window.openbot.bots.get('blinky').then(b=>b.modelId==='other-model'&&b.thinking==='high'&&b.executionAgent.modelId==='lead-model'&&b.executionAgent.thinking==='low')`);result.modelEditing=true
 const saved=await bot();assert.deepEqual(saved.tools,original.tools);assert.deepEqual(saved.skills,[]);assert.deepEqual(saved.computerTarget,{kind:'local'})
 result.themes={}
 for(const theme of ['dark','light']){
  await evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`);await delay(150)
  result.themes[theme]=await evaluate(`(()=>{const s=e=>{const c=getComputedStyle(document.querySelector(e));return {bg:c.backgroundColor,color:c.color}};return {sidebar:s('.ob-sidebar'),canvas:s('.ob-main'),card:s('.ob-bot-resource-links button')}})()`)
  if(theme==='dark')for(const v of Object.values(result.themes[theme])){const rgb=v.bg.match(/[\d.]+/g)?.slice(0,3).map(Number);if(rgb?.length===3)assert.ok(Math.max(...rgb)-Math.min(...rgb)<=1,'green-tinted surface '+v.bg)}
  await shot('details-'+theme)
 }
 await evaluate(`window.openbot.settings.update({theme:'dark'})`)
 for(const width of [720,1200]){await cmd('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true)}await cmd('Emulation.clearDeviceMetricsOverride')
 await escape();await send('__SIMPLE__');assert.ok((await rows()).some(r=>r.model==='other-model'&&r.effort==='high'))
 const task=await evaluate(`window.openbot.tasks.create('blinky','Independent edited Agent probe','Edited Agent')`);await wait(`window.openbot.tasks.list().then(a=>a.some(t=>t.id===${JSON.stringify(task.id)}&&t.status==='completed'))`);assert.deepEqual(task.executionAgent,{backendId:'codex',modelId:'lead-model',thinking:'low'})
 await idle();await stop();app=launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 const restored=await bot();assert.equal(restored.modelId,'other-model');assert.equal(restored.thinking,'high');assert.deepEqual(restored.executionAgent,{backendId:'codex',modelId:'lead-model',thinking:'low'});assert.equal(restored.executionAgentDisabled,undefined);result.restartReadback=true
 // Switch the conversation CLI through the real editor, leaving its Agent on Codex.
 await evaluate(`document.querySelector('.ob-header-bot-trigger').click()`);await pick('对话模型','本地 CLI','grok');await pick('对话模型','模型','grok-fixture');await pick('对话模型','思考深度','low');await pick('执行 Agent','模型','worker-model');await pick('执行 Agent','思考深度','high');await evaluate(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`);await wait(`window.openbot.bots.get('blinky').then(b=>b.backendId==='grok')`);await escape()
 await send('__GROK_DELEGATE__');await wait(`window.openbot.tasks.list().then(a=>a.some(t=>t.title==='Grok delegation'&&t.createdAt>=${runStartedAt}&&t.status==='completed'))`,45000);assert.ok((await rows()).some(r=>r.kind==='grok'&&r.hasGateway&&r.hasDelegationInstructions));result.grokDelegation=true
 // Actual user resource actions. Only this temporary Bot/session is addressed.
 await evaluate(`document.querySelector('.ob-header-bot-trigger').click()`)
 await evaluate(`document.querySelector('[data-bot-resource="computer"]').click()`);await wait(`!document.querySelector('[data-bot-resource="computer"]').disabled`);assert.equal(await evaluate(`!!document.querySelector('#ob-bot-details [role="alert"]')`),false);result.finderClick=true
 await evaluate(`document.querySelector('[data-bot-resource="browser"]').click()`);await wait(`!document.querySelector('[data-bot-resource="browser"]').disabled`,60000)
 const resourceError=await evaluate(`document.querySelector('#ob-bot-details [role="alert"]')?.textContent`);assert.equal(resourceError,undefined,resourceError)
 const records=await fs.readdir(path.join(data,'computers'));let owned
 for(const name of records){try{const v=JSON.parse(await fs.readFile(path.join(data,'computers',name,'ego-space.json'),'utf8'));if(v.id)owned={...v,record:path.join(data,'computers',name,'ego-space.json')}}catch{}}
 assert.ok(owned?.id);result.egoSpace={id:owned.id,name:owned.name,record:owned.record}
 const again=await evaluate(`window.openbot.bots.openResource('blinky',${JSON.stringify(home)},'browser')`);assert.equal(again.ok,true);assert.equal(again.spaceId,owned.id);result.egoClickAndReuse=true
 assert.deepEqual((await bot()).computerTarget,{kind:'local'});assert.deepEqual((await bot()).tools,original.tools)
 // Ordinary saves must not re-probe an old hidden VM target.
 await escape();await evaluate(`document.querySelector('.ob-side-item-main[aria-label="Legacy VM"]').click()`)
 await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Legacy VM')`)
 await evaluate(`document.querySelector('.ob-header-bot-trigger').click()`)
 await wait(`!!document.querySelector('#ob-bot-details')`)
 await evaluate(`(()=>{document.querySelector('#ob-bot-details .ob-bot-editor-disclosure').open=true;const e=document.querySelector('#ob-bot-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Legacy VM edited');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await evaluate(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`)
 await wait(`window.openbot.bots.get('legacy-vm').then(b=>b.name==='Legacy VM edited')`)
 const legacyVM=await evaluate(`window.openbot.bots.get('legacy-vm')`)
 assert.equal(legacyVM.computerTarget.kind,'vm');assert.equal(legacyVM.computerTarget.vmId,'offline-fixture');assert.deepEqual(legacyVM.tools,original.tools);result.hiddenLegacyTargetSave=true
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({...result,tempRoot:root},null,2));console.log(JSON.stringify({...result,tempRoot:root}))
} catch(error) {await fs.writeFile(path.join(evidence,'failure-state.json'),JSON.stringify(await evaluate(`(async()=>({text:document.body.innerText.slice(-3500),selects:Array.from(document.querySelectorAll('#ob-bot-details select')).map(s=>({label:s.getAttribute('aria-label'),value:s.value,options:Array.from(s.options).map(o=>o.value)})),bot:document.querySelector('.ob-bot-details-identity')?.innerText,backends:await window.openbot.backends.list().then(a=>a.map(b=>({id:b.id,status:b.status})))}))()`).catch(()=>null),null,2));await fs.writeFile(path.join(evidence,'failure.log'),String(error.stack||error)+'\n'+logs.slice(-10000));console.error('Fixture retained:',root);throw error}
finally {await stop();await fs.writeFile(path.join(evidence,'electron.log'),logs)}
