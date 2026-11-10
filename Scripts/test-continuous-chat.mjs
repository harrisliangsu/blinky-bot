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
let n=0, active='', steered=[]; const owner=process.ppid; setInterval(()=>{try{process.kill(owner,0)}catch{process.exit(0)}},200).unref(); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line=>{const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{}});
 else if(r.method==='model/list') send({id:r.id,result:{data:[{model:'test-model',displayName:'Test Model'}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'test-thread'}}});
 else if(r.method==='turn/start'){if(r.params.input[0].text.includes('You maintain the long-term memory')){const t='memory'; send({id:r.id,result:{turn:{id:t}}});send({method:'turn/started',params:{turn:{id:t},threadId:'test-thread'}});send({method:'item/agentMessage/delta',params:{itemId:'memory',delta:'[]'}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:t,status:'completed',items:[]}}}),10);return;} n++; require('node:fs').appendFileSync(${JSON.stringify(trace)},'turn\\n'); const turn='turn-'+n; active=turn; steered=[]; const text=r.params.input[0].text; send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{turn:{id:turn},threadId:'test-thread'}}); if(n<=2) send({method:'item/started',params:{item:{type:'agentMessage',id:'item-'+n,phase:'commentary',text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:'item-'+n,delta:(text.trim().endsWith('crash-pending') ? 'crash-active' : text.trim().endsWith('after stop') ? 'after-stop-ok' : n===3 ? (r.params.input.some(x=>x.type==='localImage' && require('node:fs').existsSync(x.path)) ? 'image-delivered' : 'image-missing') : 'working-'+n)}}); if(((n>1 && !text.trim().endsWith('queued run') && !text.trim().endsWith('queued crash run') && !text.trim().endsWith('stop test') && !text.trim().endsWith('hold for crash') && !text.trim().endsWith('crash-pending')) || text.trim().endsWith('after stop'))) setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),200);}
 else if(r.method==='turn/steer'){ const text=r.params.input[0].text; const images=r.params.input.filter(x=>x.type==='localImage'); if(images.length) require('node:fs').appendFileSync(${JSON.stringify(trace)},'image:'+images.length+':'+images.every(x=>require('node:fs').existsSync(x.path))+'\\n'); require('node:fs').appendFileSync(${JSON.stringify(trace)},'steer:'+text+'\\n'); send({id:r.id,result:{turnId:active}}); steered.push(text); if(text==='end turn' || text==='end queued') {const id=active==='turn-1'?'final-1':'final-2'; send({method:'item/started',params:{item:{type:'agentMessage',id,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:id,delta:id==='final-1'?'combined: '+steered.join(' / '):'final-2'}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:active,status:'completed',items:[]}}}),200);} }
});
`); await fs.chmod(fake,0o700);
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:process.env.BLINKY_UI_THEME || 'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'test-model',memoryExtraction:'off',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}));
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
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex' && x.status==='available'))`,40000);
 const submit=async text=>{await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)};
 await submit('first request');
 await submit('second request');
 await submit('third request');
 await wait(`!!document.querySelector('.ob-transcript-working')`);
 if(!await evalJs(`document.querySelector('.ob-transcript-working .ob-avatar')?.textContent.includes('✨')`))throw Error('Active bot avatar is missing from the working indicator');
 if(process.env.BLINKY_WORKING_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_WORKING_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`document.querySelector('.ob-side-item-main[aria-label="Coder"]').click()`);
 await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Coder') && !document.querySelector('.ob-transcript-working')`);
 await evalJs(`document.querySelector('.ob-side-item-main[aria-label="Blinky"]').click()`);
 await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Blinky') && !!document.querySelector('.ob-transcript-working .ob-avatar')`);
 await wait(`document.body.innerText.includes('working-1')`);
 await wait(`document.querySelectorAll('.ob-msg-user').length >= 3`);
 const immediate=await evalJs(`({texts:Array.from(document.querySelectorAll('.ob-msg-user')).map(x=>x.innerText),disabled:document.querySelector('#ob-prompt').disabled,oldUi:!!document.querySelector('.ob-message-queue') || Array.from(document.querySelectorAll('button')).some(b=>['引导','排队'].includes(b.textContent.trim()))})`);
 if(immediate.disabled || immediate.oldUi || !immediate.texts.some(t=>t.includes('second request')) || !immediate.texts.some(t=>t.includes('third request'))) throw Error('continuous send UI failed '+JSON.stringify(immediate));
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.length===0})()`,30000);
 let sent=''; for(let i=0;i<300;i++){sent=await fs.readFile(trace,'utf8').catch(()=>'');if(sent.includes('steer:second request') && sent.includes('steer:third request'))break;await delay(100)}
 if(!sent.includes('steer:second request') || !sent.includes('steer:third request') || (sent.match(/turn/g)||[]).length!==1) throw Error('follow-ups were not delivered to current turn: '+sent);
 await submit('end turn');
 await wait(`!document.querySelector('.ob-header .ob-working')`,30000);
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.length===0})()`,30000);
 const verify=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s.messages.filter(x=>x.role==='user').map(x=>x.content)})()`);
 for(const text of ['first request','second request','third request','end turn']) if(verify.filter(x=>x===text).length!==1) throw Error('message missing or duplicated '+text+' '+JSON.stringify(verify));
 const response=await evalJs(`Array.from(document.querySelectorAll('.ob-msg-assistant')).map(x=>x.innerText)`);
 if(!response.at(-1)?.includes('second request')||!response.at(-1)?.includes('third request')||!response.join(' ').includes('working-1'))throw Error('final answer or earlier commentary missing: '+JSON.stringify(response));
 const order=await evalJs(`Array.from(document.querySelectorAll('.ob-msg-user,.ob-msg-assistant')).map(x=>x.innerText)`);if(!order.at(-1)?.includes('combined:'))throw Error('response not after latest user message: '+JSON.stringify(order));
 if(await evalJs(`!!document.querySelector('.ob-msg-assistant .ob-msg-author')`))throw Error('Single-bot replies repeat the bot identity');
 if(process.env.BLINKY_UI_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_UI_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`Array.from(document.querySelectorAll('[aria-label="引用回复"]')).at(-1).click()`);
 await wait(`document.querySelector('.ob-composer-quote')?.innerText.includes('combined:') && document.activeElement?.id==='ob-prompt'`);
 if(process.env.BLINKY_QUOTE_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_QUOTE_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`document.querySelector('.ob-side-item-main[aria-label="Coder"]').click()`);
 await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Coder') && !document.querySelector('.ob-composer-quote')`);
 await evalJs(`document.querySelector('.ob-side-item-main[aria-label="Blinky"]').click()`);
 await wait(`document.querySelector('.ob-composer-quote')?.innerText.includes('combined:')`);
 await evalJs(`document.querySelector('[aria-label="取消引用"]').click()`);
 await wait(`!document.querySelector('.ob-composer-quote')`);
 await evalJs(`Array.from(document.querySelectorAll('[aria-label="引用回复"]')).at(-1).click()`);
 await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');return window.openbot.agent.enqueue(b.activeConversationId,'queued run',[])})()`);
 await wait(`!!document.querySelector('.ob-transcript-working')`,30000);
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.some(x=>x.text==='queued run' && x.status==='processing')})()`);
 if(await evalJs(`!!document.querySelector('.ob-message-queue') || document.body.innerText.includes('发送中')`)) throw Error('internal receipt leaked into UI');
 await submit('during queued run');
 await wait(`document.body.innerText.includes('during queued run')`);
 let delivered=false;for(let i=0;i<100;i++){sent=await fs.readFile(trace,'utf8');if(sent.includes('steer:during queued run')){delivered=true;break}await delay(100)}
 if(!delivered)throw Error('a background-started turn blocked live follow-up: '+sent);
 if(!sent.includes('[Referenced reply from Blinky]')||!sent.includes('combined: second request / third request / end turn'))throw Error('Quoted reply did not reach the active Codex turn: '+sent);
 await wait(`!!document.querySelector('.ob-msg-user .ob-msg-quote')`);
 const quoted=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s.messages.find(x=>x.role==='user'&&x.content==='during queued run')?.attachments?.find(a=>a.mime==='application/vnd.blinkybot.quote')})()`);
 if(!quoted?.data?.includes('combined: second request'))throw Error('Quoted reply was not saved with the message');
 await evalJs(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAALHwEDmIWXfgAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],'sample.png',{type:'image/png'}));document.querySelector('#ob-prompt').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))})()`);
 await wait(`document.querySelectorAll('.ob-composer-attachments li').length===1`);
 await submit('image followup');
 let imageDelivered=false;for(let i=0;i<100;i++){sent=await fs.readFile(trace,'utf8');if(sent.includes('image:1:true') && sent.includes('steer:image followup')){imageDelivered=true;break}await delay(100)}
 if(!imageDelivered)throw Error('image was not sent to the active turn: '+sent);
 await submit('end queued');
 await wait(`!document.querySelector('.ob-header .ob-working')`,30000);
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.length===0})()`,30000);
 await wait(`document.body.innerText.includes('final-2')`,30000);
 await wait(`document.body.innerText.includes('working-2')`);
 const placement=await evalJs(`(()=>{const row=Array.from(document.querySelectorAll('.ob-msg-assistant .ob-msg-row')).at(-1);const bubble=row.querySelector('.ob-msg-shell').getBoundingClientRect(),actions=row.querySelector('.ob-msg-actions').getBoundingClientRect();return {bubbleRight:bubble.right,actionsLeft:actions.left,actionsRight:actions.right,viewport:document.documentElement.clientWidth}})()`);
 if(placement.actionsLeft<placement.bubbleRight-1||placement.actionsRight>placement.viewport)throw Error('Message actions are not beside the bubble: '+JSON.stringify(placement));
 await cmd('Emulation.setDeviceMetricsOverride',{width:640,height:720,deviceScaleFactor:1,mobile:false});
 await evalJs(`Array.from(document.querySelectorAll('.ob-msg-assistant [aria-label="Add reaction"]')).at(-1).focus()`);
 await wait(`(()=>{const a=Array.from(document.querySelectorAll('.ob-msg-assistant .ob-msg-actions')).at(-1);return Number(getComputedStyle(a).opacity)>.9&&a.getBoundingClientRect().right<=document.documentElement.clientWidth})()`);
 await cmd('Emulation.clearDeviceMetricsOverride');
 await evalJs(`Array.from(document.querySelectorAll('.ob-msg-assistant [aria-label="Add reaction"]')).at(-1).click()`);
 await wait(`!!document.querySelector('.ob-msg-assistant [aria-label="React 👍"]')`);
 await evalJs(`document.querySelector('.ob-msg-assistant [aria-label="React 👍"]').click()`);
 await wait(`!!document.querySelector('.ob-msg-assistant .ob-msg-reaction-summary')`);
 await evalJs(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedMessage=text}}})`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-msg-assistant [aria-label="Copy message"]')).at(-1).click()`);
 await wait(`window.__copiedMessage?.includes('working-2') && window.__copiedMessage?.includes('final-2')`);
 const deliveredMessages=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const s=await window.openbot.sessions.get(b.activeConversationId);return s.messages.filter(x=>x.role==='user' && x.content==='image followup').map(x=>x.attachments?.length)})()`);
 if(JSON.stringify(deliveredMessages)!=='[1]')throw Error('image follow-up missing or duplicated: '+JSON.stringify(deliveredMessages));
 await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');return window.openbot.agent.enqueue(b.activeConversationId,'queued crash run',[])})()`);
 await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);return q.items.some(x=>x.text==='queued crash run' && x.status==='processing')})()`);
 const turnCount=(await fs.readFile(trace,'utf8')).split('\n').filter(x=>x==='turn').length;
 const exited=new Promise(resolve=>app.once('exit',resolve));ws.close();app.kill('SIGKILL');await exited;await delay(500);
 app=launch();await connect();
 await wait(`document.body?.innerText.includes('发送状态未确认')`,30000);
 const recovered=await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Blinky');const q=await window.openbot.agent.queue(b.activeConversationId);const s=await window.openbot.sessions.get(b.activeConversationId);return {q,messages:s.messages.filter(x=>x.role==='user' && x.content==='queued crash run').length}})()`);
 if(!recovered.q.paused || recovered.q.items.find(x=>x.text==='queued crash run')?.status!=='interrupted' || recovered.messages!==1) throw Error('processing crash recovery failed: '+JSON.stringify(recovered));
 await delay(800);
 if((await fs.readFile(trace,'utf8')).split('\n').filter(x=>x==='turn').length!==turnCount)throw Error('interrupted work was automatically replayed');
 console.log(JSON.stringify({immediateBubbles:true,continuousEnter:true,noQueueControls:true,sameTurn:true,combinedResponse:true,finalAfterFollowups:true,persistedOnce:true,backgroundRunSteer:true,imageInSameTurn:true,recoveryReceipt:true,processingCrashNoReplay:true}));
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL'); await fs.rm(root,{recursive:true,force:true}); }
