import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
if (process.platform !== 'darwin') throw new Error('This packaged Electron UI test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-ui-'));
let browserInput
const fixture=http.createServer((request,response)=>{const url=new URL(request.url,'http://localhost');if(url.pathname==='/result'){browserInput=url.searchParams.get('value');response.end('ok');return}response.setHeader('content-type','text/html');response.end('<input id="input" style="position:absolute;left:20px;top:20px;width:180px;height:30px"><button id="button" style="position:absolute;left:20px;top:70px;width:100px;height:30px">Test</button><script>button.onclick=()=>fetch("/result?value="+encodeURIComponent(input.value))</script>')});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const fixtureUrl=`http://127.0.0.1:${fixture.address().port}/`;
const data = path.join(root, 'data'); await fs.mkdir(data);
const fake = path.join(root, 'fake-codex');
const trace = path.join(root, 'trace');
await fs.writeFile(fake, `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let n=0, active=''; const owner=process.ppid; setInterval(()=>{try{process.kill(owner,0)}catch{process.exit(0)}},200).unref(); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{}});
 else if(r.method==='model/list') send({id:r.id,result:{data:[{model:'test-model',displayName:'Test Model'}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'test-thread'}}});
 else if(r.method==='turn/start'){n++; require('node:fs').appendFileSync(${JSON.stringify(trace)},'turn\\n'); const turn='turn-'+n; active=turn; const text=r.params.input[0].text; send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{turn:{id:turn},threadId:'test-thread'}}); if(n===2) send({method:'item/started',params:{item:{type:'agentMessage',id:'item-2',phase:'commentary',text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:'item-'+n,delta:(text.trim().endsWith('crash-pending') ? 'crash-active' : text.trim().endsWith('after stop') ? 'after-stop-ok' : n===3 ? (r.params.input.some(x=>x.type==='localImage' && require('node:fs').existsSync(x.path)) ? 'image-delivered' : 'image-missing') : 'working-'+n)}}); if(n===2){send({method:'item/started',params:{item:{type:'agentMessage',id:'final-2',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'final-2',delta:'final-2'}})} if(((n>1 && !text.trim().endsWith('queued run') && !text.trim().endsWith('queued crash run') && !text.trim().endsWith('stop test') && !text.trim().endsWith('hold for crash') && !text.trim().endsWith('crash-pending')) || text.trim().endsWith('after stop'))) setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),200);}
 else if(r.method==='turn/steer'){ const text=r.params.input[0].text; const images=r.params.input.filter(x=>x.type==='localImage'); if(images.length) require('node:fs').appendFileSync(${JSON.stringify(trace)},'image:'+images.length+':'+images.every(x=>require('node:fs').existsSync(x.path))+'\\n'); require('node:fs').appendFileSync(${JSON.stringify(trace)},'steer:'+text+'\\n'); send({id:r.id,result:{turnId:active}}); if(text==='end turn' || text==='end queued') setTimeout(()=>send({method:'turn/completed',params:{turn:{id:active,status:'completed',items:[]}}}),200); }
});
`); await fs.chmod(fake,0o700);
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:process.env.BLINKY_UI_THEME || 'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'test-model',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}));
await fs.mkdir(path.join(data,'bots'));
for (const [index, name] of ['Blinky','Coder'].entries()) {
  const bot={id:name.toLowerCase(),name,description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'kimi',modelId:'default',followsDefault:true,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:index+1,updatedAt:index+1};
  await fs.writeFile(path.join(data,'bots',`${bot.id}.json`),JSON.stringify(bot));
}
await fs.mkdir(path.join(data,'tasks')); await fs.mkdir(path.join(data,'routines'));
await fs.mkdir(path.join(data,'sessions'));
await fs.writeFile(path.join(data,'sessions','test-session.json'),JSON.stringify({id:'test-session',title:'Agent work',cwd:root,mode:'agent',botIds:['blinky'],activeBotId:'blinky',archived:true,createdAt:1,updatedAt:1,todos:[],messages:[{id:'task-msg',role:'user',content:'执行任务指令',createdAt:1},{id:'agent-msg',role:'assistant',content:'执行过程与结果',reasoning:'检查执行状态',toolCalls:[{id:'call-1',name:'read_file',args:{path:'sample.txt'}}],createdAt:2}]}));
await fs.writeFile(path.join(data,'tasks','task-a.json'),JSON.stringify({id:'task-a',botId:'blinky',title:'测试 Agent 任务',prompt:'demo work',status:'completed',sessionId:'test-session',createdAt:Date.now(),updatedAt:Date.now(),result:'已完成'}));
await fs.writeFile(path.join(data,'tasks','task-b.json'),JSON.stringify({id:'task-b',botId:'coder',title:'其他 Bot 的任务',prompt:'other',status:'completed',sessionId:'test-session',createdAt:Date.now(),updatedAt:Date.now()}));
await fs.writeFile(path.join(data,'routines','routine-a.json'),JSON.stringify({id:'routine-a',botId:'blinky',name:'每日例程',description:'test',steps:[],trigger:{kind:'schedule',cron:'0 9 * * *'},replayMode:'adaptive',createdAt:Date.now(),lastRunAt:Date.now()}));
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
let logs='';
function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
let app=launch();
let ws; let seq=0; const pending=new Map();
function cmd(method,params={}) { const id=++seq; return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));}); }
async function evalJs(expression) { const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw new Error(v.exceptionDetails.text+' '+JSON.stringify(v.exceptionDetails.exception));return v.result.value; }
async function wait(expr,ms=25000){let end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expr))return;await delay(100)}const state=await evalJs(`({queue:document.querySelector('.ob-message-queue')?.innerText,composer:document.querySelector('#ob-prompt')?.value,tail:document.body.innerText.slice(-1600)})`).catch(()=>null);throw new Error('timeout: '+expr+' state: '+JSON.stringify(state)+' logs: '+logs.slice(-2500))}
async function connect() {
 let targets; const end=Date.now()+30000;while(Date.now()<end){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw new Error('no target '+logs.slice(-2500));
 const target=targets.find(t=>t.type==='page'); ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);if(m.error)x.reject(Error(JSON.stringify(m.error)));else x.resolve(m.result)}};
}
try {
 await connect(); await wait(`!!document.querySelector('#ob-prompt')`);
 await evalJs(`document.querySelector('.ob-header-bot-trigger').click()`);
 await wait(`document.querySelector('#ob-bot-details')?.innerText.includes('测试 Agent 任务') && document.querySelector('#ob-bot-details')?.innerText.includes('每日例程')`);
 const details=await evalJs(`document.querySelector('#ob-bot-details').innerText`);
 if(details.includes('其他 Bot 的任务') || details.includes('管理 Bot') || !details.includes('对话模型') || !details.includes('执行 Agent')) throw Error('Wrong bot details: '+details);
 await evalJs(`document.querySelector('.ob-bot-details-task > summary').click()`);
 await evalJs(`document.querySelector('.ob-bot-details-task details > summary').click()`);
 await wait(`document.querySelector('.ob-agent-transcript')?.innerText.includes('执行过程与结果')`);
 if(!await evalJs(`document.querySelector('.ob-agent-transcript').innerText.includes('执行任务指令') && document.querySelector('.ob-agent-transcript').innerText.includes('read_file') && !document.querySelector('.ob-agent-transcript textarea')`))throw Error('Execution session is incomplete or editable');
 for (const width of [1200,700]) {
   await cmd('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
   const layout=await evalJs(`(()=>{const m=document.querySelector('.ob-main').getBoundingClientRect(), p=document.querySelector('#ob-bot-details').getBoundingClientRect(), c=document.querySelector('.ob-composer').getBoundingClientRect();return {mainRight:m.right,panelLeft:p.left,composerRight:c.right,panelWidth:p.width,position:getComputedStyle(document.querySelector('#ob-bot-details')).position}})()`);
   if(layout.position==='absolute'||layout.composerRight>layout.panelLeft+1||layout.panelWidth<150)throw Error('Panel overlaps chat: '+JSON.stringify({width,layout}));
 }
 await cmd('Emulation.clearDeviceMetricsOverride');
 if(process.env.BLINKY_DETAILS_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_DETAILS_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`[...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].find(x=>x.textContent.trim()==='Bot 浏览器').click()`);
 if(!await evalJs(`[...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].some(x=>x.textContent.trim()==='Ego Browser' && x.getAttribute('aria-pressed')==='true') && [...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].some(x=>x.textContent.trim()==='Chrome')`))throw Error('Browser selector did not default to Ego or offer Chrome');
 await evalJs(`[...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].find(x=>x.textContent.trim()==='Chrome').click()`);
 if(!await evalJs(`[...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].some(x=>x.textContent.trim()==='Chrome' && x.getAttribute('aria-pressed')==='true')`))throw Error('Chrome could not be selected');
 await evalJs(`[...document.querySelectorAll('#ob-bot-details .ob-mode-btn')].find(x=>x.textContent.trim()==='Ego Browser').click()`);
 await evalJs(`(()=>{const e=document.querySelector('#ob-bot-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Blinky Updated');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await evalJs(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.id==='blinky' && x.name==='Blinky Updated' && x.computerTarget?.kind==='browser' && x.computerTarget?.provider==='ego'))`);
 const firstFrame=await evalJs(`window.openbot.bots.controlScreen('blinky',{type:'navigate',url:${JSON.stringify(fixtureUrl)}})`);
 if(!firstFrame.ok||!firstFrame.frame?.scale)throw Error('Ego browser navigation via IPC failed: '+JSON.stringify(firstFrame));
 const scale=firstFrame.frame.scale;
 for(const action of [{type:'click',x:50*scale,y:35*scale},{type:'type',text:'ipc-browser-test'},{type:'click',x:50*scale,y:85*scale}]) {
   const response=await evalJs(`window.openbot.bots.controlScreen('blinky',${JSON.stringify(action)})`);
   if(!response.ok)throw Error('Ego browser input via IPC failed: '+JSON.stringify(response));
 }
 for(let i=0;i<40&&browserInput===undefined;i++)await delay(100);
 if(browserInput!=='ipc-browser-test')throw Error('Ego browser input did not reach the fixture');
 await evalJs(`document.querySelector('[aria-label="关闭 Bot 详情"]').click()`);
 await evalJs(`document.querySelector('[aria-label="Create a bot"]').click()`);
 await wait(`!!document.querySelector('#ob-create-bot-name')`);
 if(await evalJs(`!!document.querySelector('.ob-bot-editor-section')`))throw Error('New bot dialog contains advanced configuration');
 if(process.env.BLINKY_CREATE_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_CREATE_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`(()=>{const e=document.querySelector('#ob-create-bot-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'测试新 Bot');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await evalJs(`document.querySelector('.ob-create-bot-avatar[aria-label="选择 🧭"]').click()`);
 await wait(`document.querySelector('.ob-create-bot-avatar[aria-label="选择 🧭"]').getAttribute('aria-pressed')==='true'`);
 await evalJs(`document.querySelector('.ob-create-bot-actions button[type="submit"]').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.name==='测试新 Bot' && x.emoji==='🧭' && x.backendId==='codex' && x.modelId==='test-model' && x.executionAgent?.backendId==='codex' && x.executionAgent?.modelId==='test-model' && x.tools.includes('delegate_task')))`);
 await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('测试新 Bot')`);
 await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}))`);
 await wait(`!!document.querySelector('.ob-palette-item')`);
 await evalJs(`[...document.querySelectorAll('.ob-palette-item')].find(x=>x.textContent.trim()==='Bots').click()`);
 await wait(`!!document.querySelector('.ob-bot-groups')`);
 await evalJs(`[...document.querySelectorAll('.ob-bot-groups button')].find(x=>x.textContent.trim()==='模板').click()`);
 await wait(`!!document.querySelector('[aria-label="Bot 模板"] .ob-bot-card-chat')`);
 await evalJs(`document.querySelector('[aria-label="Bot 模板"] .ob-bot-card-chat').click()`);
 await wait(`document.querySelector('#ob-create-bot-name')?.value==='代码开发'`);
 if(await evalJs(`!!document.querySelector('.ob-bot-editor-section')`))throw Error('Template creation contains advanced configuration');
 await evalJs(`document.querySelector('.ob-create-bot-actions button[type="submit"]').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.name==='代码开发' && x.systemPrompt.includes('你负责软件开发') && x.tools.includes('write_file') && x.tools.includes('delegate_task') && x.executionAgent?.backendId==='codex'))`);
 console.log(JSON.stringify({simpleCreation:true,templateCreation:true,defaultBinding:true,detailConfigSaved:true,filteredAgentTasks:true,readonlyAgentTranscript:true,scheduledRoutines:true,sideBySideWidths:[1200,700]}));
} finally {
 fixture.closeAllConnections();fixture.close();if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL');
 const space = await fs.readFile(path.join(data,'computers','blinky','ego-space.json'),'utf8').then(JSON.parse).catch(()=>null)
 if(Number.isSafeInteger(space?.id)) await new Promise(resolve=>{const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','ignore','ignore']});child.on('error',resolve);child.on('close',resolve);child.stdin.end(`const task=await taskSpace(${space.id});if(task.name===${JSON.stringify(space.name)})await task.finish({keep:false});`)})
 await fs.rm(root,{recursive:true,force:true});
}
