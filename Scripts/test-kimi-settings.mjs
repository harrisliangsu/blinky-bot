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
const fake = process.env.BLINKY_TEST_KIMI_BIN;
if (!fake) throw new Error('Set BLINKY_TEST_KIMI_BIN to the CLI explicitly chosen for this live test.');
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'default',memoryExtraction:'off',backends:{codex:{enabled:true,command:process.env.BLINKY_TEST_CODEX_BIN || 'codex',extraArgs:[]},kimi:{enabled:true,command:fake,extraArgs:[]}}}));
await fs.mkdir(path.join(data,'bots'));
for (const [index, name] of ['Blinky','Coder'].entries()) {
  const bot={id:name.toLowerCase(),name,description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'default',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:index+1,updatedAt:index+1};
  await fs.writeFile(path.join(data,'bots',`${bot.id}.json`),JSON.stringify(bot));
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
try {
 await connect();
 await wait(`!!document.querySelector('#ob-prompt')`);
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='kimi' && x.status==='available' && x.models.some(m=>m.id==='kimi-code/kimi-for-coding')))`,40000);
 await evalJs(`document.querySelector('[aria-label="Settings (Command comma)"]').click()`);
 await wait(`!!document.querySelector('#ob-set-tab-bots')`);
 await evalJs(`document.querySelector('#ob-set-tab-bots').click()`);
 await evalJs(`(()=>{const e=document.querySelector('[aria-label="默认 CLI"]');e.value='kimi';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await wait(`window.openbot.settings.get().then(s=>s.defaultBackendId==='kimi')`);
 await wait(`Array.from(document.querySelector('[aria-label="默认模型"]')?.options||[]).some(o=>o.value==='kimi-code/kimi-for-coding')`);
 await evalJs(`(()=>{const e=document.querySelector('[aria-label="默认模型"]');e.value='kimi-code/kimi-for-coding';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await wait(`window.openbot.settings.get().then(s=>s.defaultModelId==='kimi-code/kimi-for-coding')`);
 await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`);
 await evalJs(`document.querySelector('.ob-header-bot-trigger').click()`);
 await wait(`!!document.querySelector('#ob-bot-details .ob-bot-editor')`);
 await wait(`!!document.querySelector('.ob-bot-editor-section[aria-label="对话模型"] select[aria-label="本地 CLI"]')`);
 await evalJs(`(()=>{const e=document.querySelector('.ob-bot-editor-section[aria-label="对话模型"] select[aria-label="本地 CLI"]');e.value='kimi';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await wait(`Array.from(document.querySelector('.ob-bot-editor-section[aria-label="对话模型"] select[aria-label="模型"]')?.options||[]).some(o=>o.value==='kimi-code/k3')`);
 const count=await evalJs(`document.querySelector('.ob-bot-editor-section[aria-label="对话模型"] select[aria-label="模型"]').options.length`);
 await evalJs(`(()=>{const e=document.querySelector('.ob-bot-editor-section[aria-label="对话模型"] select[aria-label="模型"]');e.value='kimi-code/k3';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`document.querySelector('.ob-bot-editor-save .ob-btn-primary').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.id==='blinky' && x.backendId==='kimi' && x.modelId==='kimi-code/k3'))`);
 const data=await evalJs(`(async()=>{const settings=await window.openbot.settings.get(); const bots=await window.openbot.bots.list(); return {defaultModel:settings.defaultModelId,botModel:bots.find(x=>x.id==='blinky')?.modelId,count:${count}}})()`);
 if(data.defaultModel===data.botModel || data.count<3)throw Error('settings not isolated or missing Kimi choices '+JSON.stringify(data));
 console.log(JSON.stringify({realKimiDiscovery:true,switchFromCodex:true,modelCount:data.count,defaultAndBotIndependent:true,settingsPersisted:true}));
} finally {if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});}
