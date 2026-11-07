// Isolated packaged Preview benchmark. No real transcript, image or credential reads.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { extractFile, listPackage } from '@electron/asar'
function syntheticImage(seed) {
  const width=1800,height=3000,row=Buffer.alloc(width*4+1),raw=Buffer.alloc(row.length*height)
  for(let x=0;x<width;x++){row[1+x*4]=(x+seed*73)%256;row[2+x*4]=(Math.floor(x/3)+seed*31)%256;row[3+x*4]=Math.floor(x/7)%256;row[4+x*4]=255}
  for(let y=0;y<height;y++)row.copy(raw,y*row.length)
  const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0}
  const chunk=(type,bytes)=>{const n=Buffer.alloc(4),t=Buffer.from(type),c=Buffer.alloc(4);n.writeUInt32BE(bytes.length);c.writeUInt32BE(crc(Buffer.concat([t,bytes])));return Buffer.concat([n,t,bytes,c])}
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64')
}

const repo=process.cwd(), variant=process.env.PERF_VARIANT??'baseline'
const executable=path.resolve(process.env.PERF_EXECUTABLE??'preview-baseline/mac-arm64/BlinkyBot Preview.app/Contents/MacOS/BlinkyBot Preview')
assert.ok(!executable.startsWith('/Applications/'))
const asar=path.resolve(path.dirname(executable),'../Resources/app.asar')
assert.equal(JSON.parse(extractFile(asar,'package.json')).blinkyBuildChannel,'preview')
const root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-perf-'+variant+'-')),home=path.join(root,'home'),appData=path.join(home,'Library/Application Support'),data=path.join(appData,'BlinkyBot Preview'),evidence=path.join(repo,'evidence',variant)
for(const p of [home,appData,data,evidence,...['bots','sessions','tasks'].map(n=>path.join(data,n))])await fs.mkdir(p,{recursive:true})
const images=[0,1,2].map(syntheticImage)
const catalog=await fs.readFile(path.join(repo,'src/shared/providerCatalog.ts'),'utf8')
const ids=[...new Set([...catalog.matchAll(/\{\s*id:\s*'([^']+)'/g)].map(m=>m[1]).concat(['codex','claude','kimi','grok','pi','droid','opencode']))]
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'en',memoryExtraction:'off',notifications:false,launchAtLogin:false,runRoutinesWhenClosed:false,backends:Object.fromEntries(ids.map(id=>[id,{enabled:false,added:false}]))}))
const msg=i=>{const n=i%200,internal=n>=55&&n<115,role=n<55?'user':'assistant';return{id:'m-'+i,role,internal,createdAt:i+1,content:internal?'Synthetic internal output. '.repeat(90):('Synthetic visible message '+i+'. ').repeat(i%20===0?25:4),...([320,400].includes(i)?{attachments:Array.from({length:2},(_,j)=>({id:'img-'+i+'-'+j,kind:'image',name:'Synthetic.png',mime:'image/png',data:images[j]}))}:{})}}
const bot={id:'scroll',name:'Synthetic Scroll',emoji:'🧪',color:'#888888',description:'Synthetic only',systemPrompt:'No tools',backendId:'codex',tools:[],computerUse:false,computerTarget:{kind:'local'},activeConversationId:'scroll-home',createdAt:1,updatedAt:1}
await fs.writeFile(path.join(data,'bots/scroll.json'),JSON.stringify(bot))
await fs.writeFile(path.join(data,'sessions/scroll-home.json'),JSON.stringify({id:'scroll-home',title:'Synthetic only',cwd:root,mode:'agent',botIds:['scroll'],activeBotId:'scroll',messages:Array.from({length:440},(_,i)=>msg(i)),todos:[],archived:false,createdAt:1,updatedAt:1}))
const env={HOME:home,PATH:'/usr/bin:/bin',SHELL:'/bin/sh',LANG:'en_US.UTF-8',TMPDIR:root+'/',XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),OPENBOT_DATA_DIR:data}
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const mainPort=await port(),uiPort=await port()
const child=spawn(executable,['--inspect-brk=127.0.0.1:'+mainPort,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+uiPort,'--user-data-dir='+data],{cwd:root,env,stdio:['ignore','pipe','pipe']})
let main,ui,logs='',sockets=[],errors=[];child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b)
const result={variant,root,executable,asarSha256:createHash('sha256').update(await fs.readFile(asar)).digest('hex'),syntheticOnly:true,realAccount:false,inputMode:process.env.PERF_PROGRAMMATIC==='1'?'Chromium scrollBy (not native wheel)':'CDP trusted wheel',stages:[]}
async function connect(port,type){let target;for(let i=0;i<300;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error('Owned Preview exited');try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>!type||x.type===type);if(target)break}catch{}await delay(100)}assert.ok(target);const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let n=0;const pending=new Map(),listeners=new Set();ws.onmessage=e=>{const v=JSON.parse(e.data);for(const f of listeners)f(v);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.text);const h=pending.get(v.id);if(h){pending.delete(v.id);clearTimeout(h.timer);v.error?h.reject(Error(v.error.message)):h.resolve(v.result)}};const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout '+method))},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});const evaluate=async expression=>{const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value};return{send,evaluate,on:f=>{listeners.add(f);return()=>listeners.delete(f)}}}
async function wait(expression){for(let i=0;i<160;i++){const v=await ui.evaluate(expression);if(v)return v;await delay(50)}throw Error('UI wait timeout '+expression)}
const metrics=async()=>Object.fromEntries((await ui.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]))
async function stage(name,{wheel=false,updates=false,css='',duration=2500}={}){
  const windowState=await main.evaluate(`e.app.show();w.show();e.app.focus({steal:true});w.focus();({visible:w.isVisible(),hidden:e.app.isHidden(),minimized:w.isMinimized()})`);await wait(`document.visibilityState==='visible'`);

  await ui.evaluate(`document.getElementById('perf-style')?.remove();${css?`const st=document.createElement('style');st.id='perf-style';st.textContent=${JSON.stringify(css)};document.head.append(st);`:''}window.receivedTaskUpdates=0;window.framesPerf=[];window.longPerf=[];window.wheelPerf=0;window.mutationsPerf={added:0,removed:0,batches:0};window.mutationObserverPerf=new MutationObserver(ms=>{mutationsPerf.batches++;for(const m of ms){mutationsPerf.added+=m.addedNodes.length;mutationsPerf.removed+=m.removedNodes.length}});mutationObserverPerf.observe(document.querySelector('.ob-transcript-content'),{subtree:true,childList:true});window.framePerf=now=>{framesPerf.push(now);window.frameId=requestAnimationFrame(framePerf)};window.frameId=requestAnimationFrame(framePerf);window.longObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())longPerf.push({start:e.startTime,duration:e.duration})});longObserver.observe({type:'longtask',buffered:false});true`)
  if(updates)await main.evaluate(`globalThis.updateN=0;globalThis.updateTimer=setInterval(()=>{w.webContents.send('openbot:event',{type:'task-summary-updated',task:{id:'synthetic-bg',botId:'scroll',sourceSessionId:'scroll-home',title:'Synthetic task',status:'running',createdAt:1,updatedAt:++updateN}})},50);true`)
  await ui.send('Profiler.start');const before=await metrics(),start=Date.now()
  const p=await ui.evaluate(`(()=>{const r=document.querySelector('.ob-transcript-scroller').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for(let n=0;Date.now()-start<duration;n++){if(wheel){if(process.env.PERF_PROGRAMMATIC==='1')await ui.evaluate(`document.querySelector('.ob-transcript-scroller').scrollBy(0,${n<duration/100?-150:150})`);else await ui.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:n<duration/100?-150:150});}await delay(35)}
  const sentUpdates=updates?await main.evaluate(`clearInterval(updateTimer);updateN`):0;if(updates)await wait(`receivedTaskUpdates===${sentUpdates}`);
  await delay(220);const after=await metrics(),profile=(await ui.send('Profiler.stop')).profile
  const timing=await ui.evaluate(`(()=>{cancelAnimationFrame(frameId);longObserver.disconnect();mutationObserverPerf.disconnect();const d=framesPerf.slice(1).map((t,i)=>t-framesPerf[i]).sort((a,b)=>a-b),q=p=>d[Math.floor((d.length-1)*p)];return{visible:document.visibilityState,focused:document.hasFocus(),frames:framesPerf.length,p50:q(.5),p95:q(.95),max:d.at(-1),over50:d.filter(x=>x>50).length,longTasks:longPerf.length,longTotalMs:longPerf.reduce((s,e)=>s+e.duration,0),wheels:wheelPerf,mutations:mutationsPerf}})()`)
  const delta={};for(const k of ['LayoutCount','LayoutDuration','RecalcStyleCount','RecalcStyleDuration','ScriptDuration','TaskDuration','JSHeapUsedSize','Nodes'])delta[k]=after[k]-before[k]
  const sampleCounts=new Map();for(const id of profile.samples??[])sampleCounts.set(id,(sampleCounts.get(id)??0)+1)
  const hot=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.split('/').at(-1),line:n.callFrame.lineNumber,samples:sampleCounts.get(n.id)??0})).filter(n=>n.samples>0).sort((a,b)=>b.samples-a.samples).slice(0,30)
  const entry={name,windowState,wallMs:Date.now()-start,updates,sentUpdates,wheel,timing,metrics:delta,hot};result.stages.push(entry);await fs.writeFile(path.join(evidence,name+'-profile.json'),JSON.stringify(profile));console.log(JSON.stringify(entry));return entry
}
try{
  main=await connect(mainPort);await main.send('Debugger.enable');let off;const paused=new Promise(resolve=>{off=main.on(v=>{if(v.method==='Debugger.paused'){off();resolve(v.params.callFrames[0].callFrameId)}})});await main.send('Runtime.runIfWaitingForDebugger')
  const setup=await main.send('Debugger.evaluateOnCallFrame',{callFrameId:await paused,expression:`(()=>{if(process.pid!==${child.pid})throw Error('Wrong owned PID');globalThis.e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');e.app.setPath('appData',${JSON.stringify(appData)});e.app.setPath('userData',${JSON.stringify(data)});return true})()`,returnByValue:true});assert.ok(!setup.exceptionDetails);await main.send('Debugger.resume');await main.send('Debugger.disable')
  ui=await connect(uiPort,'page');await ui.send('Runtime.enable');await ui.send('Performance.enable');await ui.send('Profiler.enable')
  await wait(`!!document.querySelector('#ob-prompt')`)
  await main.evaluate(`globalThis.w=e.BrowserWindow.getAllWindows()[0];w.show();e.app.focus({steal:true});w.focus();w.setSize(1100,800);globalThis.attachmentReads=0;const old=e.ipcMain._invokeHandlers.get('openbot:sessions:attachment');e.ipcMain.removeHandler('openbot:sessions:attachment');e.ipcMain.handle('openbot:sessions:attachment',(...args)=>{attachmentReads++;return old(...args)});true`)
  await ui.evaluate(`window.receivedTaskUpdates=0;window.openbot.on(event=>{if(event.type==='task-summary-updated'&&event.task.id==='synthetic-bg')receivedTaskUpdates++})`);result.runtime=await main.evaluate(`({pid:process.pid,home:process.env.HOME,userData:e.app.getPath('userData'),appPath:e.app.getAppPath(),visible:w.isVisible(),focused:w.isFocused(),gpu:e.app.getGPUFeatureStatus(),gpuDisabled:e.app.commandLine.hasSwitch('disable-gpu')})`)
  assert.equal(result.runtime.userData,data);assert.equal(result.runtime.home,home);assert.equal(result.runtime.appPath,asar);assert.equal(result.runtime.gpuDisabled,false)
  await ui.evaluate(`document.querySelector('[aria-label="Synthetic Scroll"]').click();document.addEventListener('wheel',e=>{if(e.isTrusted)window.wheelPerf=(window.wheelPerf??0)+1},{passive:true});true`)
  await wait(`document.querySelectorAll('.ob-transcript-content>.ob-msg').length>100`);await delay(700)
  result.blankControl=await main.evaluate(`(async()=>{const c=new e.BrowserWindow({show:true,width:700,height:500,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await c.loadURL('data:text/html,<title>Synthetic control</title><p>Blank frame control</p>');e.app.focus({steal:true});c.focus();const v=await c.webContents.executeJavaScript('new Promise(resolve=>{const frames=[],start=performance.now();function frame(now){frames.push(now);if(now-start<1600){requestAnimationFrame(frame);return}const gaps=frames.slice(1).map((t,i)=>t-frames[i]).sort((a,b)=>a-b);resolve({frames:frames.length,p50:gaps[Math.floor(gaps.length*.5)],p95:gaps[Math.floor(gaps.length*.95)],visible:document.visibilityState,focused:document.hasFocus()})}requestAnimationFrame(frame);setTimeout(()=>resolve({frames:frames.length,timedOut:true,visible:document.visibilityState}),2500)})');c.destroy();w.show();e.app.focus({steal:true});w.focus();return v})()`)
  await main.evaluate(`e.app.show();w.show();e.app.focus({steal:true});w.focus();true`);await delay(350);await stage('idle')
  await stage('scroll',{wheel:true})
  await stage('background',{updates:true})
  await stage('scroll-background',{wheel:true,updates:true})
  if(process.env.PERF_PROGRAMMATIC!=='1')await stage('scroll-no-mask',{wheel:true,css:'.ob-transcript-scroller { mask-image:none !important }'})
  result.correctness=[];
  await ui.evaluate(`window.openbot.settings.update({language:'zh-CN'})`);await wait(`!!document.querySelector('[aria-label="引用回复"]')`);result.correctness.push('language-change-updates-existing-bubbles');
  await main.evaluate(`w.webContents.send('openbot:event',{type:'message-start',sessionId:'scroll-home',message:{id:'synthetic-live',role:'assistant',content:'',streaming:true,createdAt:99999,segments:[{id:'live',phase:'partial_answer',text:'Synthetic live first'}]}});true`);await wait(`document.querySelector('.ob-transcript-content').textContent.includes('Synthetic live first')`);
  await main.evaluate(`w.webContents.send('openbot:event',{type:'text-delta',sessionId:'scroll-home',messageId:'synthetic-live',delta:' Synthetic live second',segment:{id:'live',phase:'partial_answer',delta:' Synthetic live second'}});true`);await wait(`document.querySelector('.ob-transcript-content').textContent.includes('Synthetic live first Synthetic live second')`);result.correctness.push('per-message-stream-still-updates');
  await ui.evaluate(`window.openbot.settings.update({language:'en'})`);await wait(`!!document.querySelector('[aria-label="Quote reply"]')`);result.correctness.push('language-can-change-back');
  await delay(300);const shot=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'preview.png'),Buffer.from(shot.data,'base64'));
  result.attachmentReads=await main.evaluate('attachmentReads');result.rendererErrors=errors;result.ok=errors.length===0
}catch(error){result.ok=false;result.failure=error.stack}
finally{await main?.evaluate(`setTimeout(()=>e.app.quit(),0);true`).catch(()=>{});for(const s of sockets)s.close();for(let i=0;i<150&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');result.forcedExit=true;result.ok=false}result.exit={code:child.exitCode,signal:child.signalCode};await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(evidence,'electron.log'),logs);console.log(JSON.stringify({ok:result.ok,failure:result.failure,evidence,exit:result.exit}));process.exitCode=result.ok?0:1}

