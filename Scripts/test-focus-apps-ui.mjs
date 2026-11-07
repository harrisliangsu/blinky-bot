import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
if (process.platform !== 'darwin') throw new Error('This packaged Electron UI test requires macOS.')
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-ui-'));
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
const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const packaged=process.env.BLINKY_PACKAGED_UI==='1';
const electron=packaged?'/Applications/BlinkyBot Preview.app/Contents/MacOS/BlinkyBot Preview':path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
let logs='';
function launch(){const child=spawn(electron,[...(packaged?[]:['.']),`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
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
 const click = async selector => { const b=await evalJs(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); for(const type of ['mousePressed','mouseReleased'])await cmd('Input.dispatchMouseEvent',{type,x:b.x,y:b.y,button:'left',clickCount:1}) };
 const key = async k => { await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:k,code:k,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9})[k]}); await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:k,code:k,windowsVirtualKeyCode:({Enter:13,Escape:27,Tab:9})[k]}) };
 await click('.ob-side-profile');await wait(`!!document.querySelector('#ob-side-account-menu')`);await key('Escape');await wait(`!document.querySelector('#ob-side-account-menu')`);const popover=await evalJs(`(()=>{const e=document.querySelector('.ob-side-profile');return {mode:document.documentElement.dataset.obInputMode,outline:getComputedStyle(e).outlineStyle}})()`);if(popover.mode!=='pointer'||popover.outline!=='none')throw Error('Pointer popover left a focus border: '+JSON.stringify(popover));await key('Tab');if(await evalJs(`document.documentElement.dataset.obInputMode`)!=='keyboard')throw Error('Keyboard focus mode was not restored');
 await evalJs(`document.querySelector('.ob-side-profile').focus()`);
 await click('.ob-side-profile'); await wait(`!!document.querySelector('#ob-side-account-menu')`);
 await click('#ob-side-account-menu button:nth-child(2)'); await wait(`!!document.querySelector('[data-apps]')`);
 await wait(`!document.querySelector('.ob-apps-intro button').disabled`);
 if(!await evalJs(`!!document.querySelector('[data-app="github"]') && !!document.querySelector('[data-app="git"]')`))throw Error('Missing available apps');
 if(process.env.BLINKY_APPS_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_APPS_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await key('Escape'); await wait(`!document.querySelector('[data-apps]')`);
 const state=await evalJs(`(()=>{const e=document.querySelector('.ob-side-profile');return {active:document.activeElement===e, visible:e.matches(':focus-visible'),outline:getComputedStyle(e).outlineStyle,mark:e.hasAttribute('data-ob-pointer-focus-restored')}})()`);
 if(state.outline!=='none')throw Error('Pointer focus border visible: '+JSON.stringify(state));
 await evalJs(`document.querySelector('[aria-label=\"Create a bot\"]').focus()`); await click('[aria-label=\"Create a bot\"]'); await wait(`!!document.querySelector('#ob-create-bot-name')`); await key('Escape'); await wait(`!document.querySelector('#ob-create-bot-name')`); const mouse=await evalJs(`(()=>{const e=document.querySelector('[aria-label=\"Create a bot\"]');return {active:document.activeElement===e,mark:e.hasAttribute('data-ob-pointer-focus-restored'),outline:getComputedStyle(e).outlineStyle}})()`); if(!mouse.active || !mouse.mark || mouse.outline!=='none') throw Error('Mouse trigger focus not restored invisibly: '+JSON.stringify(mouse));
 await key('Tab'); if(await evalJs(`!!document.querySelector('[data-ob-pointer-focus-restored]')`))throw Error('Pointer suppression persisted after keyboard navigation');
 await evalJs(`document.querySelector('[aria-label=\"Create a bot\"]').focus()`); await key('Tab'); await evalJs(`document.querySelector('[aria-label=\"Create a bot\"]').focus();document.querySelector('[aria-label=\"Create a bot\"]').click()`); await wait(`!!document.querySelector('#ob-create-bot-name')`); await key('Escape'); await wait(`!document.querySelector('#ob-create-bot-name')`); const keyboard=await evalJs(`(()=>{const e=document.querySelector('[aria-label=\"Create a bot\"]');return {active:document.activeElement===e,mark:e.hasAttribute('data-ob-pointer-focus-restored'),outline:getComputedStyle(e).outlineStyle}})()`); if(!keyboard.active || keyboard.mark || keyboard.outline==='none') throw Error('Keyboard focus not visible: '+JSON.stringify(keyboard));
 await click('.ob-side-profile'); await wait(`!!document.querySelector('#ob-side-account-menu')`);
 await click('#ob-side-account-menu button:nth-child(2)'); await wait(`!!document.querySelector('[data-apps]')`);
 await evalJs(`(()=>{let e=document.querySelector('.ob-apps-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'GitHub');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await wait(`!!document.querySelector('[data-app="github"]') && !document.querySelector('[data-app="git"]')`);
 await evalJs(`(()=>{let e=document.querySelector('.ob-apps-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await wait(`!!document.querySelector('[data-app="git"] button[aria-expanded]:not(:disabled)')`);
 await evalJs(`document.querySelector('[data-app="git"] button[aria-expanded]').click()`);
 await wait(`!!document.querySelector('[data-connect="git"]')`);
 await wait(`!!document.querySelector('[data-app="gmail"] > button') && !!document.querySelector('[data-app="calendar"]')`);
 await evalJs(`document.querySelector('[data-app="gmail"] > button').click()`);
 await wait(`!!document.querySelector('[aria-label="Google OAuth client ID"]')`);
 await evalJs(`(()=>{for(const [selector,value] of [['[aria-label="Google OAuth client ID"]','invalid-client'],['[aria-label="客户端密钥（可选）"]','fixture-secret']]){const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))}})()`);
 await evalJs(`[...document.querySelectorAll('[data-app="gmail"] button')].find(b=>b.textContent.trim()==='继续授权').click()`);
 await wait(`!!document.querySelector('[data-app="gmail"] [role="alert"]')`);
 if(await evalJs(`document.querySelector('[aria-label="客户端密钥（可选）"]').value`))throw Error('Google client secret was not cleared after submission');
 await evalJs(`[...document.querySelectorAll('[data-app="x"] button')].find(b=>b.textContent.trim()==='连接').click()`);
 await wait(`!!document.querySelector('[aria-label="X OAuth client ID"]')`);
 await evalJs(`(()=>{const e=document.querySelector('[aria-label="X OAuth client ID"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'bad');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await evalJs(`[...document.querySelectorAll('[data-app="x"] button')].find(b=>b.textContent.trim()==='继续授权').click()`);
 await wait(`!!document.querySelector('[data-app="x"] [role="alert"]')`);
 console.log(JSON.stringify({pointerPopoverNoBorder:true,pointerCloseNoBorder:true,keyboardFocusRestored:true,appsSearch:true,gitConfigurationAccessible:true,googleForms:true,invalidGoogleRejected:true,xForm:true,invalidXRejected:true,initialState:state}));
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL'); await fs.rm(root,{recursive:true,force:true}); }
