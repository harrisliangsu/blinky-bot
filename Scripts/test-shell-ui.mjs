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
 await evalJs(`document.querySelector('[aria-label="收起侧边栏"]').click()`);
 await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true}))`);
 await wait(`document.activeElement?.classList.contains('ob-side-search-input')`);
 await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',metaKey:true,bubbles:true}))`);
 await wait(`document.activeElement?.id==='ob-prompt'`);
 await evalJs(`document.querySelector('[aria-label="收起侧边栏"]').click()`);
 await wait(`!document.querySelector('.ob-sidebar') && !!document.querySelector('[aria-label="展开侧边栏"]')`);
 await evalJs(`document.querySelector('[aria-label="展开侧边栏"]').click()`);
 await wait(`!!document.querySelector('.ob-sidebar [role="separator"]')`);
 await evalJs(`document.querySelector('.ob-sidebar [role="separator"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
 const width=await evalJs(`document.querySelector('.ob-sidebar').getBoundingClientRect().width`);
 if(width!==100)throw Error('Unexpected minimum sidebar width: '+width);
 if(!await evalJs(`!!document.querySelector('.ob-sidebar.is-compact .ob-side-item-main[aria-label="Blinky"]')`))throw Error('Compact Bot is not accessible');
 const layout=await evalJs(`(()=>{const c=document.querySelector('.ob-composer').getBoundingClientRect();const t=document.querySelector('.ob-transcript').getBoundingClientRect();const s=document.querySelector('.ob-transcript-scroller');return {composerWidth:c.width,chatWidth:t.width,mask:getComputedStyle(s).maskImage}})()`);
 if(Math.abs(layout.composerWidth-layout.chatWidth)>2||!layout.mask.includes('linear-gradient'))throw Error('Chat layout or edge fade missing: '+JSON.stringify(layout));
 const floating=await evalJs(`(()=>{const h=document.querySelector('.ob-header'), t=document.querySelector('.ob-transcript'), b=document.querySelector('.ob-header-bot-trigger'), a=document.querySelector('.ob-side-compact-actions');const hr=h.getBoundingClientRect(),tr=t.getBoundingClientRect(),br=b.getBoundingClientRect(),ar=a.getBoundingClientRect();return {position:getComputedStyle(h).position,overlay:Math.abs(hr.top-tr.top)<2,centered:Math.abs((br.left+br.right-tr.left-tr.right)/2)<2,actionsBelowBots:ar.top>document.querySelector('.ob-side-list').getBoundingClientRect().bottom,blur:getComputedStyle(b).backdropFilter}})()`);
 if(floating.position!=='absolute'||!floating.overlay||!floating.centered||!floating.actionsBelowBots||!floating.blur.includes('blur'))throw Error('Floating chat controls not laid out correctly: '+JSON.stringify(floating));
 if(process.env.BLINKY_UI_SCREENSHOT){const shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.BLINKY_UI_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 await evalJs(`document.querySelector('[aria-label="收起侧边栏"]').click()`);
 await wait(`!document.querySelector('.ob-sidebar')`);
 await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true}))`);
 await wait(`document.activeElement?.classList.contains('ob-side-search-input') && !document.querySelector('.ob-sidebar.is-compact')`);
 await evalJs(`document.querySelector('[aria-label="Settings (Command comma)"]').click()`);
 await wait(`!!document.querySelector('#ob-set-tab-backends')`);
 const nav=await evalJs(`({models:document.querySelector('#ob-set-tab-backends').innerText,permissions:!!document.querySelector('#ob-set-tab-permissions')})`);
 if(nav.models!=='模型'||nav.permissions)throw Error('Incorrect navigation: '+JSON.stringify(nav));
 await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`);
 await evalJs(`document.querySelector('.ob-side-profile').click()`);
 await evalJs(`Array.from(document.querySelectorAll('.ob-side-popover-item')).find(b=>b.textContent.trim()==='工具').click()`);
 await wait(`!!document.querySelector('[role="tablist"]')`);
 const tabs=await evalJs(`Array.from(document.querySelectorAll('[role="tab"]')).map(x=>x.textContent.trim())`);
 if(!tabs.includes('Skills')||!tabs.includes('MCP'))throw Error('Missing tool tabs: '+JSON.stringify(tabs));
 console.log(JSON.stringify({collapseRestore:true,keyboardFocus:true,minimumWidth:width,modelsNavigation:true,permissionsHidden:true,toolsTabs:tabs}));
} finally { if(ws)ws.close();app.kill('SIGTERM');await delay(500);if(app.exitCode===null)app.kill('SIGKILL'); await fs.rm(root,{recursive:true,force:true}); }
