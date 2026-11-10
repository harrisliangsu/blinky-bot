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
 else if(r.method==='model/list') { if(require('node:fs').existsSync(${JSON.stringify(path.join(root,'fail-model'))})) send({id:r.id,error:{code:-32000,message:'fixture failure'}}); else setTimeout(()=>send({id:r.id,result:{data:[{model:'test-model',displayName:'Test Model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'max'},{reasoningEffort:'ultra'}]},{model:'other-model',displayName:'Other Model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}}),3200); }
 else if(r.method==='thread/start'||r.method==='thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'test-thread'}}});
 else if(r.method==='turn/start'){n++; require('node:fs').appendFileSync(${JSON.stringify(trace)},'turn\\n'); const turn='turn-'+n; active=turn; const text=r.params.input[0].text; send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{turn:{id:turn},threadId:'test-thread'}}); if(n===2) send({method:'item/started',params:{item:{type:'agentMessage',id:'item-2',phase:'commentary',text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:'item-'+n,delta:(text.trim().endsWith('crash-pending') ? 'crash-active' : text.trim().endsWith('after stop') ? 'after-stop-ok' : n===3 ? (r.params.input.some(x=>x.type==='localImage' && require('node:fs').existsSync(x.path)) ? 'image-delivered' : 'image-missing') : 'working-'+n)}}); if(n===2){send({method:'item/started',params:{item:{type:'agentMessage',id:'final-2',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'final-2',delta:'final-2'}})} if(((n>1 && !text.trim().endsWith('queued run') && !text.trim().endsWith('queued crash run') && !text.trim().endsWith('stop test') && !text.trim().endsWith('hold for crash') && !text.trim().endsWith('crash-pending')) || text.trim().endsWith('after stop'))) setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),200);}
 else if(r.method==='turn/steer'){ const text=r.params.input[0].text; const images=r.params.input.filter(x=>x.type==='localImage'); if(images.length) require('node:fs').appendFileSync(${JSON.stringify(trace)},'image:'+images.length+':'+images.every(x=>require('node:fs').existsSync(x.path))+'\\n'); require('node:fs').appendFileSync(${JSON.stringify(trace)},'steer:'+text+'\\n'); send({id:r.id,result:{turnId:active}}); if(text==='end turn' || text==='end queued') setTimeout(()=>send({method:'turn/completed',params:{turn:{id:active,status:'completed',items:[]}}}),200); }
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
 await wait(`!!document.querySelector('#ob-prompt')`);
 await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex' && x.models.some(m=>m.id==='test-model' && m.supportedThinking?.includes('ultra'))))`,40000);
 await fs.writeFile(path.join(root,'fail-model'),'fail');
 const fallback=await evalJs(`window.openbot.backends.recheck('codex').then(a=>a.find(x=>x.id==='codex'))`);
 if(!fallback.models.some(m=>m.id==='other-model')||!fallback.statusDetail.includes('previously detected'))throw Error('A failed model refresh discarded the previous catalog: '+JSON.stringify(fallback));
 await fs.unlink(path.join(root,'fail-model'));
 await evalJs(`document.querySelector('[aria-label="Settings (Command comma)"]').click()`);
 await wait(`!!document.querySelector('#ob-set-tab-backends')`);
 await evalJs(`document.querySelector('#ob-set-tab-bots').click()`);
 if(!await evalJs(`Array.from(document.querySelector('[aria-label="默认模型"]').options).some(o=>o.value==='other-model')`))throw Error('Default model selector lost the delayed catalog');
 await evalJs(`document.querySelector('#ob-set-tab-backends').click()`);
 await wait(`!!document.querySelector('[data-manage-backend="codex"]')`);
 await evalJs(`document.querySelector('[data-manage-backend="codex"]').click()`);
 await wait(`!!document.querySelector('#ob-effort-codex')`);
 const options=await evalJs(`Array.from(document.querySelector('#ob-effort-codex').options).map(o=>o.value)`);
 if(!options.includes('max')||!options.includes('ultra')||options.includes('low'))throw Error('wrong first model options: '+JSON.stringify(options));
 await evalJs(`(()=>{const e=document.querySelector('#ob-effort-codex');e.value='ultra';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-backend-editor-footer button')).find(b=>b.textContent.includes('保存')).click()`);
 await wait(`window.openbot.settings.get().then(s=>s.backends.codex.modelThinking?.['default']==='ultra')`);
 await evalJs(`document.querySelector('[data-manage-backend="codex"]').click()`);
 await evalJs(`(()=>{const e=document.querySelector('#ob-model-codex');e.value='other-model';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 const other=await evalJs(`Array.from(document.querySelector('#ob-effort-codex').options).map(o=>o.value)`);
 if(!other.includes('low')||other.includes('ultra'))throw Error('wrong second model options: '+JSON.stringify(other));
 await evalJs(`(()=>{const e=document.querySelector('#ob-effort-codex');e.value='low';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-backend-editor-footer button')).find(b=>b.textContent.includes('保存')).click()`);
 await wait(`window.openbot.settings.get().then(s=>s.backends.codex.modelThinking?.['other-model']==='low')`);
 await evalJs(`document.querySelector('[data-manage-backend="codex"]').click()`);
 await evalJs(`(()=>{const e=document.querySelector('#ob-model-codex');e.value='default';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 const defaults=await evalJs(`Array.from(document.querySelector('#ob-effort-codex').options).map(o=>o.value)`);
 if(!defaults.includes('ultra'))throw Error('CLI default used stale model capabilities: '+JSON.stringify(defaults));
 await evalJs(`(()=>{const e=document.querySelector('#ob-model-codex');e.value='other-model';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`(()=>{const e=document.querySelector('#ob-effort-codex');e.value='';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-backend-editor-footer button')).find(b=>b.textContent.includes('保存')).click()`);
 await wait(`window.openbot.settings.get().then(s=>!s.backends.codex.modelThinking?.['other-model'])`);
 console.log(JSON.stringify({modelSpecificOptions:true,maxUltra:true,persisted:true,reset:true}));
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL'); await fs.rm(root,{recursive:true,force:true}); }
