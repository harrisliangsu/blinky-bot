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
 else if(r.method==='turn/start'){n++; const turn='turn-'+n; active=turn; const text=r.params.input[0].text; send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{turn:{id:turn},threadId:'test-thread'}}); if(n===2) send({method:'item/started',params:{item:{type:'agentMessage',id:'item-2',phase:'commentary',text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:'item-'+n,delta:(text.trim().endsWith('crash-pending') ? 'crash-active' : text.trim().endsWith('after stop') ? 'after-stop-ok' : n===3 ? (r.params.input.some(x=>x.type==='localImage' && require('node:fs').existsSync(x.path)) ? 'image-delivered' : 'image-missing') : 'working-'+n)}}); if(n===2){send({method:'item/started',params:{item:{type:'agentMessage',id:'final-2',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'final-2',delta:'final-2'}})} if(((n>1 && !text.trim().endsWith('stop test') && !text.trim().endsWith('hold for crash') && !text.trim().endsWith('crash-pending')) || text.trim().endsWith('after stop'))) setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),200);}
 else if(r.method==='turn/steer'){ if(r.params.expectedTurnId!==active) {send({id:r.id,error:{code:-1,message:'wrong turn'}});return;} if(r.params.input[0].text==='crash-pending') return; const turn=active; send({id:r.id,result:{turnId:turn}}); setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),200); }
});
`); await fs.chmod(fake,0o700);
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'test-model',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}));
await fs.mkdir(path.join(data,'bots'));
for (const [index, name] of ['Blinky','Coder'].entries()) {
  const bot={id:name.toLowerCase(),name,description:'test',systemPrompt:'test',emoji:'✨',color:'#7c9cff',backendId:'kimi',modelId:'default',followsDefault:true,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:index+1,updatedAt:index+1};
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
 await wait(`Boolean(document.querySelector('#ob-prompt') && document.querySelector('.ob-side-list'))`);
 const migrated=await evalJs(`window.openbot.bots.list().then(a=>a.every(b=>b.followsDefault===false && b.backendId==='codex' && b.modelId==='test-model'))`);
 if(!migrated) throw Error('legacy Bot binding did not retain its effective model');
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex' && x.status==='available'))`,40000);
 const submit=async text=>{await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)};
 const draft=async text=>{await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)};
 await draft('Blinky draft');
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(b=>b.textContent.includes('Coder')).click()`);
 await wait(`document.querySelector('.ob-header-title .ob-header-bot-trigger .ob-avatar + span')?.textContent==='Coder' && document.querySelector('#ob-prompt')?.value===''`);
 await draft('Coder draft');
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(b=>b.textContent.includes('Blinky')).click()`);
 await wait(`document.querySelector('.ob-header-title .ob-header-bot-trigger .ob-avatar + span')?.textContent==='Blinky' && document.querySelector('#ob-prompt')?.value==='Blinky draft'`);
 await draft('');
 await submit('first request');
 await submit('second queued request');
 await wait(`document.body.innerText.includes('working-1')`);
 await wait(`!document.querySelector('#ob-prompt').disabled`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(b=>b.textContent.includes('Coder')).click()`);
 await wait(`document.querySelector('.ob-header-title .ob-header-bot-trigger .ob-avatar + span')?.textContent==='Coder' && document.querySelector('#ob-prompt')?.value==='Coder draft'`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(b=>b.textContent.includes('Blinky')).click()`);
 await wait(`document.querySelector('.ob-header-title .ob-header-bot-trigger .ob-avatar + span')?.textContent==='Blinky' && document.body.innerText.includes('second queued request')`);
 await wait(`!document.querySelector('[aria-label="Stop the run"]')`,30000);
 await submit('change direction');
 await wait(`document.body.innerText.includes('working-2')`,30000);
 await wait(`!document.querySelector('[aria-label="Stop the run"]')`,30000);
 await wait(`document.querySelectorAll('.ob-msg-segment').length===2`);
 if(await evalJs(`!!document.querySelector('.ob-message-queue') || Array.from(document.querySelectorAll('button')).some(b=>['引导','排队'].includes(b.textContent.trim()))`)) throw Error('legacy controls still visible');
 const isolated=await evalJs(`(async()=>{const before=await window.openbot.bots.list();await window.openbot.settings.update({defaultBackendId:'claude',defaultModelId:'opus'});const after=await window.openbot.bots.list();return before.every((x,i)=>x.backendId===after[i].backendId && x.modelId===after[i].modelId)})()`);
 if(!isolated)throw Error('global settings changed bot binding');
 await evalJs(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAALHwEDmIWXfgAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],'sample.png',{type:'image/png'}));document.querySelector('#ob-prompt').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))})()`);
 await wait(`document.querySelectorAll('.ob-composer-attachments li').length===1`);
 const imageCount=await evalJs(`document.querySelectorAll('.ob-composer-attachments li').length`);
 if(imageCount!==1)throw Error('image duplicated');
 await submit('image check');
 await wait(`document.body.innerText.includes('image-delivered')`,30000);
 await wait(`!document.querySelector('[aria-label="Stop the run"]')`,30000);
 await submit('stop test');
 await wait(`document.body.innerText.includes('working-4')`);
 await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');await window.openbot.agent.pauseQueue(b.activeConversationId,true);await window.openbot.agent.enqueue(b.activeConversationId,'after stop',[])})()`);
 await wait(`document.body.innerText.includes('after stop')`);
 await evalJs(`document.querySelector('[aria-label="Stop the run"]').click()`);
 await wait(`document.body.innerText.includes('继续处理')`);
 if(await evalJs(`document.body.innerText.includes('after-stop-ok')`)) throw Error('stopped message ran prematurely');
 await evalJs(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='继续处理').click()`);
 await wait(`document.body.innerText.includes('after-stop-ok')`,30000);
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');return (await window.openbot.agent.queue(b.activeConversationId)).items.length===0})()`,30000);
 const result=await evalJs(`({text:document.body.innerText,hasNewChat:!!document.querySelector('[aria-label*="New chat"]'),composerDisabled:document.querySelector('#ob-prompt').disabled,border:getComputedStyle(document.querySelector('.ob-composer-box')).borderWidth})`);
 if(result.hasNewChat || result.composerDisabled || parseFloat(result.border)<1) throw Error('Chat entry or light composer is not usable');
 if (process.env.BLINKY_UI_SCREENSHOT) { const shot=await cmd('Page.captureScreenshot',{format:'png'}); await fs.writeFile(process.env.BLINKY_UI_SCREENSHOT,Buffer.from(shot.data,'base64')); }
 await submit('hold for crash');
 await wait(`document.body.innerText.includes('hold for crash') && !!document.querySelector('[aria-label="Stop the run"]')`);
 await submit('crash-pending');
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.some(x=>x.text==='crash-pending' && x.status==='running')})()`,30000);
 const exited=new Promise(resolve=>app.once('exit',resolve)); ws.close(); app.kill('SIGKILL'); await exited; await delay(500);
 app=launch(); await connect();
 await wait(`document.body?.innerText.includes('发送状态未确认')`,30000);
 const recovery=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');return window.openbot.agent.queue(b.activeConversationId)})()`);
 if(!recovery.paused || recovery.items[0]?.status!=='interrupted') throw Error('crash recovery did not pause the in-flight message');
 await delay(500);
 if(await evalJs(`!!document.querySelector('[aria-label="Stop the run"]')`)) throw Error('interrupted message was replayed');
 await evalJs(`document.querySelector('[aria-label="Create a bot"]').click()`);
 await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Bot 模板')`);
 await evalJs(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Bot 模板').click()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-template-categories button')).find(b=>b.textContent.trim()==='开发').click()`);
 await wait(`document.querySelectorAll('.ob-template-grid li').length===3`);
 await evalJs(`(()=>{const e=document.querySelector('[aria-label="搜索 Bot 模板"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'代码审阅');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await wait(`document.querySelectorAll('.ob-template-grid li').length===1`);
 await evalJs(`document.querySelector('.ob-template-grid button').click()`);
 await wait(`document.querySelector('#ob-bot-name')?.value==='代码审阅' && document.querySelector('#ob-bot-prompt')?.value.includes('审阅代码')`);
 await evalJs(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Create bot').click()`);
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.name==='代码审阅' && x.systemPrompt.includes('审阅代码') && x.followsDefault===false))`);
 console.log(JSON.stringify({inputReleased:!result.composerDisabled,draftIsolated:true,followupDelivered:result.text.includes('second queued request'),nextTurn:result.text.includes('change direction'),noNewChat:!result.hasNewChat,lightBorder:result.border,botSettingIsolated:isolated,clipboardAttachments:imageCount,imageDelivered:result.text.includes('image-delivered'),crashRecovery:true,templateCreated:true}));
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL'); await fs.rm(root,{recursive:true,force:true}); }
