// Real application, isolated HOME/data, real image IPC and trusted Electron input.
// Uses synthetic messages only. No account, model, Keychain, user Space or send.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

function syntheticImage(seed) {
  const width=1800,height=3000,row=Buffer.alloc(width*4+1),raw=Buffer.alloc(row.length*height)
  for(let x=0;x<width;x++){row[1+x*4]=(x+seed*73)%256;row[2+x*4]=(Math.floor(x/3)+seed*31)%256;row[3+x*4]=Math.floor(x/7)%256;row[4+x*4]=255}
  for(let y=0;y<height;y++)row.copy(raw,y*row.length)
  const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0}
  const chunk=(type,bytes)=>{const n=Buffer.alloc(4),t=Buffer.from(type),c=Buffer.alloc(4);n.writeUInt32BE(bytes.length);c.writeUInt32BE(crc(Buffer.concat([t,bytes])));return Buffer.concat([n,t,bytes,c])}
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64')
}

const repo = process.cwd(), mode = process.env.SCROLL_MODE ?? 'baseline'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-scroll-'+mode+'-'))
const home = path.join(root, 'home'), data = path.join(root, 'data'), evidence = path.join(repo, 'evidence', mode)
for (const dir of [home, data, evidence, ...['bots','sessions','tasks'].map(n=>path.join(data,n))]) await fs.mkdir(dir,{recursive:true})
const images = [0,1,2].map(syntheticImage)
const backends = Object.fromEntries(['codex','claude','claude-code','grok','kimi','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id=>[id,{enabled:false,extraArgs:[]}]))
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'en',memoryExtraction:'off',notifications:false,notifyOnComplete:false,runRoutinesWhenClosed:false,launchAtLogin:false,backends}))
const message=(i)=>({id:'m-'+i,role:i%2?'assistant':'user',content:('Synthetic message '+i+'\n').repeat(3),createdAt:i+1,...((i>=750 || i%17===0)?{attachments:Array.from({length:3},(_,j)=>({id:'img-'+i+'-'+j,kind:'image',name:'synthetic-tall-'+j+'.png',mime:'image/png',data:images[j]}))}:{})})
const base={emoji:'🧪',color:'#888888',description:'Synthetic scroll regression',systemPrompt:'Synthetic only',backendId:'codex',tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}
for (const [id,count] of [['scroll',800],['other',30]]) {
  await fs.writeFile(path.join(data,'bots',id+'.json'),JSON.stringify({...base,id,name:id,activeConversationId:id+'-home'}))
  await fs.writeFile(path.join(data,'sessions',id+'-home.json'),JSON.stringify({id:id+'-home',title:id+' synthetic',cwd:root,mode:'agent',botIds:[id],activeBotId:id,messages:Array.from({length:count},(_,i)=>message(i)),todos:[],archived:false,createdAt:1,updatedAt:1}))
}
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const port=await freePort(), mainPort=await freePort()
const executable=process.env.SCROLL_EXECUTABLE??path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const env=Object.fromEntries(['PATH','USER','LOGNAME','LANG','LC_ALL','SHELL','TMPDIR','__CF_USER_TEXT_ENCODING'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),OPENBOT_DATA_DIR:data,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'})
const app=spawn(executable,[...(process.env.SCROLL_EXECUTABLE?[]:[repo]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--inspect=127.0.0.1:'+mainPort,'--user-data-dir='+path.join(root,'chromium')],{cwd:root,env,stdio:['ignore','pipe','pipe']})
let logs='',sockets=[],errors=[],ui,main,result={mode,root,realElectron:true,realApplication:true,realModel:false,syntheticOnly:true,isolatedHome:home,checks:[]}
result.sourceSha256={}
for(const file of ['src/renderer/src/components/Message.tsx','src/renderer/src/components/Transcript.tsx','src/renderer/src/lib/useTranscriptScroll.ts','out/main/index.js', 'Scripts/test-chat-scroll-electron.mjs']) {
  try{result.sourceSha256[file]=createHash('sha256').update(await fs.readFile(path.join(repo,file))).digest('hex')}catch{}
}
app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b)
async function connect(p,type){
  let target
  for(let i=0;i<300;i++){
    if(app.exitCode!==null||app.signalCode!==null)throw Error('Owned Electron exited '+app.exitCode+'/'+app.signalCode+' '+logs.slice(-1500))
    try{target=(await(await fetch('http://127.0.0.1:'+p+'/json/list')).json()).find(t=>!type||t.type===type);if(target)break}catch{}
    await delay(100)
  }
  assert.ok(target,'Owned inspector ready')
  const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws)
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej})
  let n=0;const pending=new Map()
  ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails);const h=pending.get(v.id);if(h){pending.delete(v.id);clearTimeout(h.timer);v.error?h.reject(Error(v.error.message)):h.resolve(v.result)}}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
  return{send,evaluate}
}
async function wait(expression,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const v=await ui.evaluate(expression);if(v)return v;await delay(60)}throw Error('Timed out '+expression)}
async function click(selector){const before=await ui.evaluate(`window.clickReceipts??0`);const p=await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);await main.evaluate(`w.focus();w.webContents.sendInputEvent({type:'mouseDown',...${JSON.stringify(p)},button:'left',clickCount:1});w.webContents.sendInputEvent({type:'mouseUp',...${JSON.stringify(p)},button:'left',clickCount:1});true`);await wait(`(window.clickReceipts??0)>${before}`)}
async function wheel(dy){const before=await ui.evaluate(`window.wheelReceipts??0`);const p=await ui.evaluate(`(()=>{const r=document.querySelector('.ob-transcript-scroller').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);await main.evaluate(`w.focus();w.webContents.sendInputEvent({type:'mouseWheel',...${JSON.stringify(p)},deltaX:0,deltaY:${-dy},canScroll:true});true`);await wait(`(window.wheelReceipts??0)>${before}`)}
const geometry=()=>ui.evaluate(`(()=>{const e=document.querySelector('.ob-transcript-scroller');return{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,gap:e.scrollHeight-e.scrollTop-e.clientHeight,images:e.querySelectorAll('img.ob-msg-picture').length,latest:!!document.querySelector('.ob-transcript-jump')}})()`)
async function shot(name){const v=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(v.data,'base64'))}
async function event(event){if(event.type==='text-delta')event.segment={id:'stream-segment',phase:'partial_answer',delta:event.delta};await main.evaluate(`w.webContents.send('openbot:event',${JSON.stringify(event)});true`);await delay(80)}
async function anchor(){return ui.evaluate(`(()=>{const e=document.querySelector('.ob-transcript-scroller'),r=e.getBoundingClientRect();window.readAnchor=[...e.querySelectorAll('.ob-msg')].find(n=>n.getBoundingClientRect().bottom>r.top+40);return readAnchor?.getBoundingClientRect().top})()`)}
async function anchorTop(){return ui.evaluate(`window.readAnchor?.getBoundingClientRect().top`)}
async function check(name,fn){const start=Date.now();try{const detail=await fn();result.checks.push({name,pass:true,ms:Date.now()-start,...detail})}catch(e){result.checks.push({name,pass:false,ms:Date.now()-start,error:e.message});if(mode!=='baseline')throw e}}
try{
  ui=await connect(port,'page');main=await connect(mainPort);await ui.send('Runtime.enable')
  await main.evaluate(`globalThis.e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');globalThis.w=e.BrowserWindow.getAllWindows()[0];w.setSize(900,720);w.focus();globalThis.reads=[];const original=e.ipcMain._invokeHandlers.get('openbot:sessions:attachment');e.ipcMain.removeHandler('openbot:sessions:attachment');e.ipcMain.handle('openbot:sessions:attachment',async(...args)=>{reads.push({at:Date.now(),ids:args.slice(1)});await new Promise(r=>setTimeout(r,240));return original(...args)});true`)
  result.runtime=await main.evaluate(`({pid:process.pid,home:process.env.HOME,userData:e.app.getPath('userData'),appPath:e.app.getAppPath(),electron:process.versions.electron})`)
  assert.equal(result.runtime.userData,data);assert.equal(result.runtime.home,home)
  await wait(`!!document.querySelector('.ob-sidebar-bot[aria-label="scroll"]') || !!document.querySelector('[aria-label="scroll"]')`)
  await ui.evaluate(`document.addEventListener('click',()=>window.clickReceipts=(window.clickReceipts??0)+1,true);document.addEventListener('wheel',()=>window.wheelReceipts=(window.wheelReceipts??0)+1,true)`);await click('[aria-label="scroll"]');await wait(`!!document.querySelector('.ob-transcript-scroller') && document.querySelectorAll('.ob-transcript-content > .ob-msg').length>100`)
  await delay(900)
  await ui.evaluate(`window.trace=[];window.phase='init';const el=document.querySelector('.ob-transcript-scroller');window.record=(kind,extra={})=>trace.push({t:performance.now(),phase,kind,top:el.scrollTop,height:el.scrollHeight,gap:el.scrollHeight-el.scrollTop-el.clientHeight,...extra});el.addEventListener('scroll',()=>record('scroll'));el.addEventListener('wheel',e=>record('wheel',{dy:e.deltaY,trusted:e.isTrusted}));new ResizeObserver(()=>record('resize')).observe(el.firstElementChild);new MutationObserver(ms=>{for(const m of ms){for(const n of m.addedNodes)if(n.nodeName==='IMG')record('image-add');for(const n of m.removedNodes)if(n.nodeName==='IMG')record('image-remove')}}).observe(el,{childList:true,subtree:true});const original=Element.prototype.scrollTo;Element.prototype.scrollTo=function(...a){if(this===el)record('scrollTo',{args:a});return original.apply(this,a)};window.tick=()=>{record('frame');window.raf=requestAnimationFrame(tick)};tick();true`)
  await check('latest-with-delayed-images',async()=>{
    await ui.evaluate(`phase='latest';document.querySelector('.ob-transcript-scroller').scrollTop-=2200`);await delay(750)
    const start=await geometry();await shot('before-latest');await wait(`!!document.querySelector('.ob-transcript-jump')`);await click('.ob-transcript-jump');await delay(2400)
    const end=await geometry();await shot('after-latest');assert.ok(end.gap<=2,'Latest must settle at bottom: '+JSON.stringify(end));return{start,end}
  })
  await check('manual-down-stable',async()=>{
    await ui.evaluate(`phase='manual';document.querySelector('.ob-transcript-scroller').scrollTop-=1800`);await delay(700)
    const positions=[];for(let i=0;i<20;i++){await wheel(320);await delay(140);positions.push(await geometry())}
    await delay(600);const end=await geometry();const reversals=positions.slice(1).filter((g,i)=>g.top<positions[i].top-2).length
    assert.ok(end.gap<=2,'Manual down must reach bottom: '+JSON.stringify(end));assert.equal(reversals,0,'Down scroll must not reverse');return{end,reversals,positions}
  })
  await check('reader-not-pulled-by-stream',async()=>{
    await ui.evaluate(`phase='read';document.querySelector('.ob-transcript-scroller').scrollTop-=1300`);await delay(900);const before=await geometry(),beforeAnchor=await anchor()
    await event({type:'message-start',sessionId:'scroll-home',message:{id:'stream-1',role:'assistant',content:'Synthetic streaming\n',createdAt:1001,streaming:true,segments:[{id:'stream-segment',phase:'partial_answer',text:'Synthetic streaming\n'}]}})
    for(let i=0;i<6;i++)await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nSynthetic paragraph '+i+' '.repeat(5)+'streaming content '.repeat(50)})
    await delay(300);const end=await geometry(),endAnchor=await anchorTop();assert.ok(end.height>before.height+200,'Actual visible stream must grow the transcript');assert.ok(Math.abs(endAnchor-beforeAnchor)<=2,'Reader visual anchor preserved: '+beforeAnchor+' -> '+endAnchor);return{before,end,beforeAnchor,endAnchor}
  })
  await check('stream-follow-and-leave-return',async()=>{
    await ui.evaluate(`phase='follow'`);await click('.ob-transcript-jump');await delay(1500)
    for(let i=0;i<8;i++)await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nSynthetic live '+i+' live text '.repeat(50)})
    await delay(300);const follow=await geometry();assert.ok(follow.height>30000,'Actual visible stream has grown');assert.ok(follow.gap<=2,'Streaming follows bottom')
    await wheel(-500);await delay(300);const away=await geometry();assert.ok(away.gap>100,'User can leave bottom')
    await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nMore synthetic streaming '.repeat(30)})
    const still=await geometry();assert.ok(Math.abs(still.top-away.top)<=2,'Stream does not pull reader')
    await click('.ob-transcript-jump');await delay(1500);await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nFinal synthetic streaming '.repeat(30)})
    const end=await geometry();assert.ok(end.gap<=2,'Returning restores follow');return{follow,away,still,end}
  })
  await check('loaded-images-retained',async()=>{
    const t=await ui.evaluate(`trace.filter(e=>e.kind==='image-remove')`)
    assert.equal(t.length,0,'Loaded images must not collapse on visibility exit');return{imageRemovals:t.length}
  })
  await check('small-upward-input-releases-follow',async()=>{
    await ui.evaluate(`phase='small-up'`);await wheel(-35);await delay(250);const before=await anchor(),position=await geometry()
    await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nSynthetic small-up test '.repeat(60)})
    await delay(200);const after=await anchorTop();assert.ok(Math.abs(after-before)<=2,'Small upward input must stop following');return{before,after,position,end:await geometry()}
  })
  await check('background-task-layout-updates',async()=>{
    await wheel(-350);await delay(300);const before=await anchor()
    const task={id:'synthetic-background',botId:'scroll',title:'Synthetic task',sourceSessionId:'scroll-home',status:'running',createdAt:1,updatedAt:1}
    await event({type:'task-summary-updated',task});await delay(100);assert.ok(Math.abs(await anchorTop()-before)<=2,'Background status preserves reading anchor')
    await click('.ob-transcript-jump');await delay(200);await event({type:'task-summary-updated',task:{...task,status:'completed',updatedAt:2}})
    const end=await geometry();assert.ok(end.gap<=2,'Background layout follows bottom');return{before,end}
  })
  await check('keyboard-reading-and-end-follow',async()=>{
    await ui.evaluate(`document.querySelector('.ob-transcript-scroller').focus()`)
    await main.evaluate(`w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:'PageUp'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'PageUp'});true`);await delay(500)
    const away=await geometry(),before=await anchor();assert.ok(away.gap>100,'PageUp leaves bottom')
    await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nSynthetic keyboard reading '.repeat(30)})
    assert.ok(Math.abs(await anchorTop()-before)<=2,'Keyboard reader is not pulled')
    await main.evaluate(`w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});true`);await delay(600)
    await event({type:'text-delta',sessionId:'scroll-home',messageId:'stream-1',delta:'\nSynthetic End key '.repeat(30)})
    const end=await geometry();assert.ok(end.gap<=2,'End re-engages streaming follow');return{away,end}
  })
  await check('resize-follow-and-reading-anchor',async()=>{
    await wheel(-400);await delay(200);await click('.ob-transcript-jump');await delay(500)
    await main.evaluate(`w.setSize(1120,850);true`);await delay(700);const bottom=await geometry();assert.ok(bottom.gap<=2,'Viewport grows at bottom')
    await main.evaluate(`w.setSize(760,620);true`);await delay(700);const narrow=await geometry();assert.ok(narrow.gap<=2,'Viewport shrinks at bottom')
    await wheel(-1100);await delay(600);await anchor()
    await main.evaluate(`w.setSize(920,740);true`);await delay(700);const reading=await geometry();assert.ok(reading.gap>200,'Resize must not pull reader to bottom');return{bottom,narrow,reading}
  })
  await check('history-prepend-anchor-and-window',async()=>{
    await ui.evaluate(`phase='history';document.querySelector('.ob-transcript-scroller').scrollTop=0`);await delay(700)
    const count=await ui.evaluate(`document.querySelectorAll('.ob-transcript-content>.ob-msg').length`);assert.equal(count,200)
    const before=await anchor();await click('.ob-earlier');await delay(1400);const after=await anchorTop()
    assert.ok(Math.abs(after-before)<=2,'Prepending history preserves existing message: '+before+' -> '+after)
    const expanded=await ui.evaluate(`document.querySelectorAll('.ob-transcript-content>.ob-msg').length`);assert.equal(expanded,400);return{count,expanded,before,after}
  })
  await check('draft-and-overlay-scroll-retained',async()=>{
    await ui.evaluate(`phase='draft';const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'SYNTHETIC UNSENT DRAFT');e.dispatchEvent(new Event('input',{bubbles:true}))`)
    await delay(200);const before=await geometry();await click('.ob-header-bot-trigger');await delay(400)
    await main.evaluate(`w.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});true`);await delay(300)
    const after=await geometry();assert.ok(Math.abs(after.top-before.top)<=2,'Overlay keeps main scroller');assert.equal(await ui.evaluate(`document.querySelector('#ob-prompt').value`),'SYNTHETIC UNSENT DRAFT');return{before,after}
  })
  await check('switch-chat-and-late-images',async()=>{
    await click('[aria-label="other"]');await wait(`document.querySelectorAll('.ob-transcript-content>.ob-msg').length===30`);await delay(500)
    const other=await geometry();assert.ok(other.gap<=2,'New chat opens at bottom')
    await click('[aria-label="scroll"]');await wait(`document.querySelectorAll('.ob-transcript-content>.ob-msg').length===200`);await delay(1400)
    const back=await geometry();assert.ok(back.gap<=2,'Returning chat follows mounted content and slow images');assert.equal(await ui.evaluate(`document.querySelector('#ob-prompt').value`),'SYNTHETIC UNSENT DRAFT');return{other,back}
  })
  await check('reduced-motion-and-dark-mode',async()=>{
    await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await ui.evaluate(`phase='reduced-motion';document.querySelector('.ob-transcript-scroller').scrollTop-=1000`);await delay(400)
    await click('.ob-transcript-jump');const immediate=await geometry();assert.ok(immediate.gap<=2,'Reduced-motion Latest is immediate')
    await ui.evaluate(`window.openbot.settings.update({theme:'dark'})`);await wait(`document.documentElement.dataset.theme==='dark'`);await delay(350);const textColor=await ui.evaluate(`getComputedStyle(document.querySelector('.ob-msg-bubble')).color`);assert.ok(Number(textColor.match(/\d+/)?.[0])>180,'Stable dark-theme text must be readable: '+textColor);await shot('dark-latest')
    assert.equal(await ui.evaluate(`document.documentElement.scrollWidth>window.innerWidth`),false,'No horizontal overflow');return{immediate,textColor}
  })
  result.performance=await ui.evaluate(`({messageNodes:document.querySelectorAll('.ob-transcript-content>.ob-msg').length,heapBytes:performance.memory?.usedJSHeapSize,frames:trace.filter(e=>e.kind==='frame').length})`)
  result.final=await geometry();result.reads=await main.evaluate(`reads`);result.rendererErrors=errors;result.ok=result.checks.every(c=>c.pass)&&errors.length===0
}catch(e){result.ok=false;result.failure=e.stack;if(ui)await shot('failure').catch(()=>{})}
finally{
  if(main)result.reads=await main.evaluate(`reads`).catch(()=>[])
  if(ui){result.trace=await ui.evaluate(`cancelAnimationFrame(window.raf);window.trace??[]`).catch(()=>[])}
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(evidence,'electron.log'),logs)
  if(main)await main.evaluate(`setTimeout(()=>e.app.quit(),0);true`).catch(()=>{});for(const s of sockets)s.close()
  for(let i=0;i<300&&app.exitCode===null&&app.signalCode===null;i++)await delay(100)
  if(app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');result.shutdownForced=true}
  result.exit={code:app.exitCode,signal:app.signalCode};for(const s of sockets)s.close()
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({...result,trace:result.trace?.length,reads:result.reads?.length}));process.exitCode=result.ok?0:1
}
