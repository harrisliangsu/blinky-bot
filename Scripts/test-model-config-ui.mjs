import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
if (process.platform !== 'darwin') throw new Error('This Electron UI test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-ui-'));
const data = path.join(root, 'data'); await fs.mkdir(data);
const fake = path.join(root, 'fake-codex');
const trace = path.join(root, 'trace');
await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
let n = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r = JSON.parse(line);
 if (r.method === 'initialize') send({id:r.id,result:{}});
 else if (r.method === 'model/list') send({id:r.id,result:{data:[
  {model:'native-model',displayName:'Native Model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}]},
  {model:'other-model',displayName:'Other Model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}
 ],nextCursor:null}});
 else if (r.method === 'thread/start' || r.method === 'thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'model-thread-'+process.pid}}});
 else if (r.method === 'turn/start') {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(r.params)+'\\n');
  const id = 'turn-'+(++n);
  send({id:r.id,result:{turn:{id}}});
  send({method:'turn/started',params:{turn:{id},threadId:'model-thread-'+process.pid}});
  send({method:'item/started',params:{item:{type:'agentMessage',id,phase:'final_answer',text:''}}});
  send({method:'item/agentMessage/delta',params:{itemId:id,delta:'Model configuration verified.'}});
  setTimeout(()=>send({method:'turn/completed',params:{turn:{id,status:'completed',items:[]}}}),20);
 }
});
`); await fs.chmod(fake,0o700);
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'other-model',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[],defaultModelId:'other-model',modelThinking:{'other-model':'low','native-model':'ultra'}}}}));
await fs.mkdir(path.join(data,'bots'));
for (const [index, name] of ['Blinky','Coder'].entries()) {
 const bot={id:name.toLowerCase(),name,description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'native-model',followsDefault:false,thinking:'high',executionAgent:{backendId:'codex',modelId:'other-model',thinking:'low'},tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:index+1,updatedAt:index+1};
 await fs.writeFile(path.join(data,'bots',bot.id+'.json'),JSON.stringify(bot));
}
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

const check = (value, message) => { if (!value) throw Error(message); };
const botSection = '#ob-bot-details section[aria-label="对话模型"]';
const agentSection = '#ob-bot-details section[aria-label="执行 Agent"]';
async function select(section, label, value) {
 const selector=JSON.stringify(`${section} select[aria-label="${label}"]`);
 await wait(`Array.from(document.querySelector(${selector})?.options??[]).some(o=>o.value===${JSON.stringify(value)})`);
 await evalJs(`(()=>{const e=document.querySelector(${selector});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await wait(`document.querySelector(${selector})?.value===${JSON.stringify(value)}`);
}
const escape = () => cmd('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
async function click(selector) {
 const point=await evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
 await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
}
const traceRows = async () => (await fs.readFile(trace,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
async function send(text) {
 const before=(await traceRows()).length;
 await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await evalJs(`document.querySelector('#ob-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
 for(let i=0;i<250;i++) {
  const rows=await traceRows();
  const matching=rows.slice(before).find(row=>row.input?.some(item=>item.text?.includes(text)));
  if(matching) {
   // Text and the working indicator can finish before the backend releases its
   // turn. Await the runtime, or a subsequent send may steer the prior model.
   await wait(`window.openbot.bots.list().then(async a=>!await window.openbot.agent.isRunning(a.find(b=>b.id==='blinky').activeConversationId))`);
   return matching;
  }
  await delay(100);
 }
 throw Error('No CLI turn: '+logs.slice(-2000));
}
async function stopApp() {
 ws?.close(); app.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>app.once('exit',resolve)),delay(3000)]);
 if(app.exitCode===null) app.kill('SIGKILL');
}
try {
 await connect(); await wait(`!!document.querySelector('#ob-prompt')`);
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex' && x.models.some(m=>m.id==='native-model')))`,40000);
 await evalJs(`document.querySelector('.ob-header-bot-trigger').click()`);
 await wait(`!!document.querySelector('#ob-bot-details')`);
 await select(botSection,'模型','default');
 const options=await evalJs(`Array.from(document.querySelector('${botSection} select[aria-label="思考深度"]').options).map(o=>o.value)`);
 check(options.includes('ultra') && !options.includes('low'),'Native default capabilities were taken from the connection preference: '+JSON.stringify(options));
 await select(botSection,'思考深度','');
 await select(agentSection,'模型','native-model');
 await select(agentSection,'思考深度','ultra');
 await evalJs(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.id==='blinky' && x.modelId==='default' && !x.thinking && x.executionAgent?.thinking==='ultra'))`);
 await escape(); await wait(`!document.querySelector('#ob-bot-details')`);
 const native=await send('native default probe');
 check(!native.model && !native.effort,'Pinned Bot inherited connection model or depth: '+JSON.stringify({model:native.model,effort:native.effort}));
 await evalJs(`document.querySelector('.ob-header-bot-trigger').click()`);
 await select(botSection,'模型','other-model'); await select(botSection,'思考深度','low');
 await evalJs(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.id==='blinky' && x.modelId==='other-model' && x.thinking==='low'))`);
 await escape();
 const botTurn=await send('explicit Bot probe');
 check(botTurn.model==='other-model' && botTurn.effort==='low','Bot selection did not reach turn/start: '+JSON.stringify({model:botTurn.model,effort:botTurn.effort}));
 const task=await evalJs(`window.openbot.tasks.create('blinky','independent worker probe','Model test')`);
 check(task?.executionAgent?.modelId==='native-model' && task.executionAgent.thinking==='ultra','Task did not snapshot independent configuration');
 await wait(`window.openbot.tasks.list().then(a=>a.some(t=>t.id===${JSON.stringify(task.id)} && t.status==='completed'))`);
 const worker=(await traceRows()).find(row=>row.model==='native-model' && row.effort==='ultra' && row.input.some(x=>x.text?.includes('independent worker probe')));
 check(worker,'Execution Agent model and effort did not reach turn/start');

 // Change connection preferences through its editor, then read both Bots back.
 await evalJs(`document.querySelector('[aria-label="Settings (Command comma)"]').click()`);
 await wait(`!!document.querySelector('#ob-set-tab-backends')`);
 await evalJs(`document.querySelector('#ob-set-tab-backends').click()`);
 await wait(`!!document.querySelector('[data-manage-backend="codex"]')`);
 await evalJs(`document.querySelector('[data-manage-backend="codex"]').click()`);
 await evalJs(`(()=>{const e=document.querySelector('#ob-model-codex');e.value='native-model';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-backend-editor-footer button')).find(b=>b.textContent==='保存').click()`);
 await wait(`window.openbot.settings.get().then(s=>s.backends.codex.defaultModelId==='native-model')`);
 const bots=await evalJs(`window.openbot.bots.list()`);
 check(bots.find(b=>b.id==='blinky').thinking==='low' && bots.find(b=>b.id==='blinky').executionAgent.thinking==='ultra' && bots.find(b=>b.id==='coder').thinking==='high','Connection change overwrote a Bot or Agent');
 await escape(); await wait(`!document.querySelector('[role="dialog"]')`);

 // Native pointer events exercise focus-visible, unlike HTMLElement.click().
 await click('[aria-label="Create a bot"]'); await wait(`!!document.querySelector('#ob-create-bot-name')`);
 await escape(); await wait(`!document.querySelector('#ob-create-bot-name')`);
 check(await evalJs(`getComputedStyle(document.activeElement).outlineStyle==='none'`),'Pointer-opened modal left a focus border');
 await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 check(await evalJs(`!document.querySelector('[data-ob-pointer-focus-restored]')`),'Pointer suppression survived keyboard navigation');
 await evalJs(`(()=>{const e=document.querySelector('[aria-label="Create a bot"]');e.focus();e.click()})()`);
 await wait(`!!document.querySelector('#ob-create-bot-name')`);
 await escape(); await wait(`!document.querySelector('#ob-create-bot-name')`);
 check(await evalJs(`document.activeElement.matches('[aria-label="Create a bot"]') && getComputedStyle(document.activeElement).outlineStyle!=='none'`),'Keyboard-opened modal did not restore a visible focus indicator');

 await evalJs(`document.querySelector('.ob-sidebar [role="separator"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
 const minimum=await evalJs(`document.querySelector('.ob-sidebar').getBoundingClientRect().width`);
 check(minimum===100,'Sidebar is narrower than the traffic-light safe area: '+minimum);
 for(const width of [720,1200]) {
  await cmd('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
  const edge=await evalJs(`document.querySelector('.ob-sidebar').getBoundingClientRect().right`);
  check(edge>=100,'Window resize crossed traffic-light safe area');
 }
 await cmd('Emulation.clearDeviceMetricsOverride');
 const themes={};
 for(const theme of ['light','dark']) {
  await evalJs(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
  // Sidebar controls animate their surfaces for 180ms when tokens change.
  await delay(250);
  const surface=await evalJs(`(()=>{const e=document.querySelector('.ob-msg-assistant .ob-msg-answer'),s=getComputedStyle(e);return {sidebar:getComputedStyle(document.querySelector('.ob-sidebar')).backgroundColor,canvas:getComputedStyle(document.querySelector('.ob-app')).backgroundColor,radii:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius]}})()`);
  check(surface.radii.every(r=>parseFloat(r)>0) && new Set(surface.radii).size===1,'AI reply has unequal or square corners: '+JSON.stringify(surface));
  if(theme==='light') check(surface.sidebar==='rgb(255, 255, 255)','Light sidebar is tinted: '+JSON.stringify(surface));
  themes[theme]=surface;
  if(process.env.BLINKY_MODEL_UI_SCREENSHOT_DIR) {
   await fs.mkdir(process.env.BLINKY_MODEL_UI_SCREENSHOT_DIR,{recursive:true});
   const shot=await cmd('Page.captureScreenshot',{format:'png'});
   await fs.writeFile(path.join(process.env.BLINKY_MODEL_UI_SCREENSHOT_DIR,theme+'.png'),Buffer.from(shot.data,'base64'));
  }
 }
 await stopApp(); app=launch(); await connect(); await wait(`!!document.querySelector('#ob-prompt')`);
 const restored=await evalJs(`window.openbot.bots.list().then(a=>a.find(b=>b.id==='blinky'))`);
 check(restored.modelId==='other-model' && restored.thinking==='low' && restored.executionAgent.modelId==='native-model' && restored.executionAgent.thinking==='ultra','Model configuration did not survive restart');
 check(await evalJs(`document.querySelector('.ob-sidebar').getBoundingClientRect().width===100`),'Sidebar width did not survive restart');
 console.log(JSON.stringify({botAndAgentIsolation:true,connectionIsolation:true,codexWireValues:true,nativeDefaultWire:true,nativeModelOptions:true,restartReadback:true,pointerFocus:true,keyboardFocus:true,sidebarMinimum:minimum,themes}));
} finally { await stopApp(); await fs.rm(root,{recursive:true,force:true}); }
