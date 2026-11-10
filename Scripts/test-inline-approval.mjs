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
 else if(r.method==='turn/start'){const turn='approval-turn';active=turn;send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'test-thread'}});send({id:901,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',turnId:turn,command:'echo synthetic-check'}});}
 else if(r.id===901 && r.result){require('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify(r.result));send({method:'item/started',params:{item:{type:'agentMessage',id:'final',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'final',delta:'confirmation complete'}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:active,status:'completed',items:[]}}}),20);}
 else if(r.method==='turn/steer')send({id:r.id,result:{turnId:active}});
});
`); await fs.chmod(fake,0o700);
await fs.writeFile(path.join(data,'settings.json'), JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'test-model',memoryExtraction:'off',approvalPolicy:'ask-every-time',backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}));
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
 await wait(`!!document.querySelector('#ob-prompt')`);
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex' && x.status==='available'))`,40000);
 await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'需要确认的测试');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
 await wait(`!!document.querySelector('.ob-transcript .ob-approval')`,30000);
 const state=await evalJs(`({overlay:!!document.querySelector('.ob-approval-scrim'),disabled:document.querySelector('#ob-prompt').disabled,card:document.querySelector('.ob-approval').innerText})`);
 if(state.overlay||state.disabled||!state.card.includes('synthetic-check'))throw Error('approval not inline or composer blocked '+JSON.stringify(state));
 await evalJs(`document.querySelector('#ob-prompt').focus()`);
 await wait(`document.activeElement?.id==='ob-prompt'`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(x=>x.innerText.includes('Coder')).click()`);
 await wait(`!!document.querySelector('.ob-approval-elsewhere')`,30000);
 if(await evalJs(`!!document.querySelector('.ob-transcript .ob-approval')`))throw Error('approval shown in the wrong chat');
 await evalJs(`document.querySelector('.ob-approval-elsewhere').click()`);
 await wait(`!!document.querySelector('.ob-transcript .ob-approval')`,30000);
 await delay(500);
 await evalJs(`Array.from(document.querySelectorAll('.ob-approval button')).find(b=>b.textContent.includes('拒绝')).click()`);
 let result;for(let i=0;i<100;i++){try{result=JSON.parse(await fs.readFile(trace,'utf8'));break}catch{await delay(100)}}
 if(result?.decision!=='decline')throw Error('rejection did not reach executor: '+JSON.stringify(result));
 await wait(`document.body.innerText.includes('confirmation complete')`,30000);
 console.log(JSON.stringify({inline:true,composerUsable:true,originPreserved:true,rejectionDelivered:true}));
} finally {if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});}
