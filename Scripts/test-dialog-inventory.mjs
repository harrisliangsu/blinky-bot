import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
if (process.platform !== 'darwin') throw new Error('This Electron UI test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-dialog-inventory-'));
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
async function wait(expr,ms=7000){let end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expr))return;await delay(100)}throw new Error('timeout: '+expr)}
async function connect() {
 let targets; const end=Date.now()+30000;while(Date.now()<end){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
 if(!targets?.some(t=>t.type==='page'))throw new Error('no target '+logs.slice(-2500));
 const target=targets.find(t=>t.type==='page'); ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);if(m.error)x.reject(Error(JSON.stringify(m.error)));else x.resolve(m.result)}};
}

const results=[];
const esc=async()=>{await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})};
async function click(selector, keyboard=false) {
 await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
 if(selector.includes('ob-side-item-action')) {
  await evalJs(`document.querySelector(${JSON.stringify(selector)}).parentElement.querySelector('.ob-side-item-main').focus()`);
 }
 if(keyboard) {
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.click()})()`);
 }else{
  const p=await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
 }
}
async function focusState(selector) {return evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),a=document.activeElement;return {restored:a===e,active:a?.className,outline:e?getComputedStyle(e).outlineStyle:null}})()`)}
async function surface(name, opener, opened, options={}) {
 for(const keyboard of [false,true]) {
  try {
   await options.prepare?.(keyboard);
   await click(opener,keyboard); await wait(opened);
   const editable=options.editable;
   if(editable)await evalJs(`document.querySelector(${JSON.stringify(editable)})?.focus()`);
   await esc(); await wait(`!(${opened})`);
   await wait(`document.activeElement===document.querySelector(${JSON.stringify(options.returnTo||opener)})`,1800).catch(()=>{});
   const focus=await focusState(options.returnTo||opener);
   results.push({name,mode:keyboard?'keyboard':'mouse',escape:true,focus,pass:focus.restored&&(keyboard?focus.outline!=='none':focus.outline==='none')});
   console.log(JSON.stringify(results.at(-1)));
   await options.after?.();
  }catch(error){results.push({name,mode:keyboard?'keyboard':'mouse',pass:false,error:String(error.message)});await esc();await esc();}
 }
}
try {
 await connect();await wait(`!!document.querySelector('#ob-prompt')`);
 await surface('sidebar account menu','.ob-side-profile',`!!document.querySelector('#ob-side-account-menu')`);
 await surface('settings','[aria-label="Settings (Command comma)"]',`!!document.querySelector('.ob-set')`,{editable:'.ob-set-search input'});
 await surface('create Bot','[aria-label="Create a bot"]',`!!document.querySelector('#ob-create-bot-name')`,{editable:'#ob-create-bot-name'});
 await surface('Bot details','.ob-header-bot-trigger',`!!document.querySelector('#ob-bot-details')`,{editable:'#ob-bot-name'});
 for(const kind of ['cli','provider']) {
  await surface(`${kind} catalog`,`[data-add-${kind}]`,`!!document.querySelector('[data-catalog="${kind}"]')`,{
   prepare:async()=>{await click('[aria-label="Settings (Command comma)"]');await click('#ob-set-tab-backends');},
   editable:`[data-catalog-search="${kind}"]`,after:async()=>{await esc();await wait(`!document.querySelector('[role="dialog"]')`)}
  });
 }
 await surface('model connection editor','[data-manage-backend="codex"]',`!!document.querySelector('.ob-backend-editor')`,{
  prepare:async()=>{await click('[aria-label="Settings (Command comma)"]');await click('#ob-set-tab-backends');await wait(`!!document.querySelector('[data-manage-backend="codex"]')`);},
  editable:'#ob-cmd-codex',after:async()=>{await esc();await wait(`!document.querySelector('[role="dialog"]')`)}
 });
 await surface('new provider editor','[data-provider-choice="openai"]',`!!document.querySelector('.ob-backend-editor')`,{
  prepare:async(keyboard)=>{await click('[aria-label="Settings (Command comma)"]',keyboard);await click('#ob-set-tab-backends',keyboard);await click('[data-add-provider]',keyboard);},
  editable:'#ob-key-openai',returnTo:'[data-add-provider]',after:async()=>{await esc();await wait(`!document.querySelector('[role="dialog"]')`)}
 });
 // Workspace menus must restore their persistent account button after the
 // clicked menu item itself has been removed by opening the workspace.
 for(const [name,index,opened] of [['settings from account',1,`!!document.querySelector('.ob-set')`],['apps workspace',2,`!!document.querySelector('[data-apps]')`],['tools workspace',3,`!!document.querySelector('[data-tools]')`]]) {
  await surface(name,`#ob-side-account-menu button:nth-child(${index})`,opened,{prepare:async()=>click('.ob-side-profile'),returnTo:'.ob-side-profile'});
 }
 // Palette-driven entry points preserve the trigger from before the palette.
 for(const keyboard of [true]) {
  await evalJs(`document.querySelector('#ob-prompt').focus()`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:4,windowsVirtualKeyCode:75});
  await wait(`!!document.querySelector('.ob-palette')`);
  await esc();await wait(`!document.querySelector('.ob-palette')`);
  results.push({name:'command palette',mode:'keyboard shortcut',escape:true,focus:await focusState('#ob-prompt')});
 }
 for(const label of ['Bots','Routines']) {
  await evalJs(`document.querySelector('#ob-prompt').focus()`);
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:4,windowsVirtualKeyCode:75});await wait(`!!document.querySelector('.ob-palette')`);
  const selector=await evalJs(`(()=>{const buttons=[...document.querySelectorAll('.ob-palette-item')];const e=buttons.find(b=>b.textContent.trim()===${JSON.stringify(label)});e.dataset.qaTarget='entry';return '[data-qa-target="entry"]'})()`);
  await click(selector);await wait(`!!document.querySelector(${JSON.stringify(label==='Bots'?'.ob-bots':'.ob-routines')})`);
  if(label==='Bots') {
   await click('.ob-bot-card-main');await wait(`!!document.querySelector('.ob-bots-drawer')`);await evalJs(`document.querySelector('#ob-bot-name').focus()`);await esc();await wait(`!document.querySelector('.ob-bots-drawer')`);
   results.push({name:'Bot editor drawer',escape:await evalJs(`!document.querySelector('.ob-bots-drawer')&&!!document.querySelector('.ob-bots')`),focus:await focusState('.ob-bot-card-main')});
  }
  await esc();await wait(`!document.querySelector('[role="dialog"]')`);
  results.push({name:label,escape:true,focus:await focusState('#ob-prompt')});
 }
 for(const keyboard of [false,true]) {
  await click('.ob-side-item-action[aria-label="Edit Blinky"]',keyboard);await wait(`!!document.querySelector('.ob-bots-drawer')`);
  await evalJs(`document.querySelector('#ob-bot-name').focus()`);await esc();await wait(`!document.querySelector('.ob-bots-drawer')`);await wait(`document.activeElement===document.querySelector('.ob-bot-card-main')`,1800).catch(()=>{});
  results.push({name:'direct Sidebar Bot editor drawer',mode:keyboard?'keyboard':'mouse',escape:true,focus:await focusState('.ob-bot-card-main')});
  await esc();await wait(`!document.querySelector('[role="dialog"]')`);
 }
 console.log(JSON.stringify({root,results}));
 await fs.writeFile(path.join(root,'dialog-results.json'),JSON.stringify(results,null,2));
 if(results.some(r=>r.pass===false||r.escape===false||r.focus?.restored===false))throw Error('Dialog inventory contains a failed close or focus return');
}finally{await fs.writeFile(path.join(root,'dialog-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({report:path.join(root,'dialog-results.json')}));ws?.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(data,{recursive:true,force:true});}

