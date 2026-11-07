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

const repo=process.cwd(), variant=process.env.PERF_VARIANT??'visibility-candidate'
const executable=path.resolve(process.env.PERF_EXECUTABLE??'preview-candidate/mac-arm64/BlinkyBot Preview.app/Contents/MacOS/BlinkyBot Preview')
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
const result={variant,root,executable,asarSha256:createHash('sha256').update(await fs.readFile(asar)).digest('hex'),syntheticOnly:true,realAccount:false,inputMode:'guarded CDP wheel if genuinely visible; otherwise no wheel',foregroundSteals:0,visibilityOverrides:0,stages:[]}
async function connect(port,type){let target;for(let i=0;i<300;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error('Owned Preview exited');try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>!type||x.type===type);if(target)break}catch{}await delay(100)}assert.ok(target);const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let n=0;const pending=new Map(),listeners=new Set();ws.onmessage=e=>{const v=JSON.parse(e.data);for(const f of listeners)f(v);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.text);const h=pending.get(v.id);if(h){pending.delete(v.id);clearTimeout(h.timer);v.error?h.reject(Error(v.error.message)):h.resolve(v.result)}};const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout '+method))},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});const evaluate=async expression=>{const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value};return{send,evaluate,on:f=>{listeners.add(f);return()=>listeners.delete(f)}}}
async function wait(expression){for(let i=0;i<160;i++){const v=await ui.evaluate(expression);if(v)return v;await delay(50)}throw Error('UI wait timeout '+expression)}
const metrics=async()=>Object.fromEntries((await ui.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]))
const geom=()=>ui.evaluate(`(()=>{const e=document.querySelector('.ob-transcript-scroller');return{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,gap:e.scrollHeight-e.clientHeight-e.scrollTop,images:e.querySelectorAll('img.ob-msg-picture').length}})()`)
const sendEvent=async value=>{await main.evaluate(`w.webContents.send('openbot:event',${JSON.stringify(value)});true`);await delay(220)}
async function until(expression,timeout=3500){const end=Date.now()+timeout;while(Date.now()<end){if(await ui.evaluate(expression))return;await delay(60)}throw Error('Condition timeout '+expression)}
async function correctness(){
  const checks=[]
  await ui.evaluate(`document.querySelector('.ob-transcript-scroller').scrollTop=1e9`);await delay(300)
  await sendEvent({type:'message-start',sessionId:'scroll-home',message:{id:'focused-live',role:'assistant',content:'',streaming:true,createdAt:99999,segments:[{id:'live',phase:'partial_answer',text:'Synthetic focused stream\n\n'}]}})
  let segmentText='Synthetic focused stream\n\n'
  async function delta(tag){const addition=('Synthetic '+tag+' paragraph. ').repeat(100)+'\n\n';segmentText+=addition;await sendEvent({type:'text-delta',sessionId:'scroll-home',messageId:'focused-live',delta:addition,segment:{id:'live',phase:'partial_answer',delta:addition}});await until(`document.querySelector('.ob-transcript-content').textContent.includes(${JSON.stringify(tag)})`)}
  const before=await geom();await delta('follow-check');await delay(300);const follow=await geom();assert.ok(follow.height>before.height+100);assert.ok(follow.gap<=2);checks.push({name:'real-segment-growth-follows-bottom',before,after:follow})
  await ui.evaluate(`document.querySelector('.ob-transcript-scroller').scrollTop-=450`);await delay(300);const away=await geom();await delta('reader-check');await delay(300);const reader=await geom();assert.ok(Math.abs(reader.top-away.top)<=2);assert.ok(reader.gap>away.gap);checks.push({name:'reading-position-not-pulled-by-stream',before:away,after:reader})
  await until(`!!document.querySelector('.ob-transcript-jump')`);await ui.evaluate(`document.querySelector('.ob-transcript-jump').click()`);await delay(200);await delta('return-check');await delay(300);const returned=await geom();assert.ok(returned.gap<=2);checks.push({name:'latest-handler-restores-follow',after:returned,input:'DOM click in actual Preview, not native mouse'})
  await ui.evaluate(`document.querySelector('.ob-transcript-scroller').scrollTop-=400`);await delay(250);const langBefore=await geom();await ui.evaluate(`window.openbot.settings.update({language:'zh-CN'})`);await until(`!!document.querySelector('[aria-label="引用回复"]')`);const langAfter=await geom();assert.ok(Math.abs(langAfter.top-langBefore.top)<=2);checks.push({name:'language-update-retains-reader-position',before:langBefore,after:langAfter})
  return checks
}
try{
  main=await connect(mainPort);await main.send('Debugger.enable');let off;const paused=new Promise(resolve=>{off=main.on(v=>{if(v.method==='Debugger.paused'){off();resolve(v.params.callFrames[0].callFrameId)}})});await main.send('Runtime.runIfWaitingForDebugger')
  const setup=await main.send('Debugger.evaluateOnCallFrame',{callFrameId:await paused,expression:`(()=>{if(process.pid!==${child.pid})throw Error('Wrong owned PID');globalThis.e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');e.app.setPath('appData',${JSON.stringify(appData)});e.app.setPath('userData',${JSON.stringify(data)});globalThis.windowTimeline=[];globalThis.windowRecord=(kind,win)=>windowTimeline.push({at:Date.now(),kind,...(win?{visible:win.isVisible(),focused:win.isFocused(),minimized:win.isMinimized()}:{}),appHidden:e.app.isHidden()});for(const name of ['hide','unhide','activate','did-become-active','did-resign-active'])e.app.on(name,()=>windowRecord('app-'+name));e.app.on('browser-window-created',(_,win)=>{windowRecord('created',win);for(const name of ['show','hide','focus','blur','minimize','restore','ready-to-show'])win.on(name,()=>windowRecord(name,win))});e.BrowserWindow.prototype.show=function(){windowRecord('startup-show-deferred',this)};return true})()`,returnByValue:true});assert.ok(!setup.exceptionDetails);await main.send('Debugger.resume');await main.send('Debugger.disable')
  ui=await connect(uiPort,'page');await ui.send('Runtime.enable');await ui.send('Performance.enable')
  await wait(`!!document.querySelector('#ob-prompt')`)
  await main.evaluate(`globalThis.w=e.BrowserWindow.getAllWindows()[0];const area=e.screen.getPrimaryDisplay().workArea;w.setBounds({x:area.x+area.width-720,y:area.y+area.height-520,width:720,height:520});globalThis.windowSampler=setInterval(()=>windowRecord('sample',w),100);true`)
  result.runtime=await main.evaluate(`({pid:process.pid,home:process.env.HOME,userData:e.app.getPath('userData'),appPath:e.app.getAppPath(),backgroundThrottling:w.webContents.getBackgroundThrottling(),gpuDisabled:e.app.commandLine.hasSwitch('disable-gpu')})`)
  assert.equal(result.runtime.userData,data);assert.equal(result.runtime.appPath,asar);assert.notEqual(result.runtime.backgroundThrottling,false);assert.equal(result.runtime.gpuDisabled,false)
  await ui.evaluate(`window.visibilityTimeline=[];window.visibilityRecord=kind=>visibilityTimeline.push({at:Date.now(),kind,state:document.visibilityState,focused:document.hasFocus()});for(const kind of ['visibilitychange','focus','blur'])window.addEventListener(kind,()=>visibilityRecord(kind));visibilityRecord('before-show');window.wheelEvents=[];document.querySelector('[aria-label="Synthetic Scroll"]').click();document.addEventListener('wheel',event=>wheelEvents.push({at:Date.now(),dy:event.deltaY,trusted:event.isTrusted}),{passive:true});true`)
  await wait(`!!document.querySelector('.ob-transcript-scroller')`)
  await main.evaluate(`w.showInactive();windowRecord('requested-show-inactive',w);true`)
  const samples=[];let stable=true
  for(let n=0;n<15;n++){await delay(100);const value=await ui.evaluate(`({at:Date.now(),state:document.visibilityState,focused:document.hasFocus()})`);samples.push(value);if(value.state!=='visible')stable=false}
  result.visibilityGate={passed:stable,samples,requiredMs:1500}
  if(stable){
    await ui.evaluate(`document.querySelector('.ob-transcript-scroller').scrollTop=1e9;window.framesVisible=[];window.tickVisible=t=>{framesVisible.push(t);window.frameVisible=requestAnimationFrame(tickVisible)};window.frameVisible=requestAnimationFrame(tickVisible);true`);await delay(250)
    await ui.evaluate(`window.scrollTrace=[];window.wheelPhase='before';window.receivedUpdates=0;document.querySelector('.ob-transcript-scroller').addEventListener('scroll',event=>scrollTrace.push({at:performance.now(),top:event.currentTarget.scrollTop,phase:wheelPhase}),{passive:true});window.openbot.on(event=>{if(event.type==='task-summary-updated'&&event.task.id==='visible-bg')receivedUpdates++});true`)
    const before=await geom(),mBefore=await metrics();let interrupted=false,upEnd
    if(process.env.PERF_WITH_UPDATES==='1')await main.evaluate(`globalThis.bgCounter=0;globalThis.bgTimer=setInterval(()=>{w.webContents.send('openbot:event',{type:'task-summary-updated',task:{id:'visible-bg',botId:'scroll',sourceSessionId:'scroll-home',title:'Synthetic task',status:'running',createdAt:1,updatedAt:++bgCounter}});if(bgCounter===60)clearInterval(bgTimer)},50);true`)
    async function wheelOnce(dy){
      if(interrupted||await ui.evaluate(`document.visibilityState!=='visible'`)){interrupted=true;return}
      const receipt=await ui.evaluate('wheelEvents.length'),point=await ui.evaluate(`(()=>{const r=document.querySelector('.ob-transcript-scroller').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await ui.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:dy});await until(`wheelEvents.length>${receipt} || document.visibilityState!=='visible'`,1500)
      if(await ui.evaluate(`document.visibilityState!=='visible'`)){interrupted=true;return}await delay(90)
    }
    for(const dy of [-500,500]){
      await ui.evaluate(`wheelPhase=${JSON.stringify(dy<0?'up':'down')}`)
      for(let n=0;n<12&&!interrupted;n++)await wheelOnce(dy)
      await delay(250);if(dy<0)upEnd=await geom()
    }
    for(let n=0;n<6&&!interrupted&&(await geom()).gap>2;n++)await wheelOnce(500)
    if(process.env.PERF_WITH_UPDATES==='1'&&!interrupted)await until(`receivedUpdates===60`,4000)
    if(process.env.PERF_WITH_UPDATES==='1')await main.evaluate(`clearInterval(bgTimer);true`)
    await delay(250);const after=await geom(),mAfter=await metrics(),events=await ui.evaluate('wheelEvents'),scrollTrace=await ui.evaluate('scrollTrace')
    const actualDirection=Boolean(upEnd&&upEnd.top<before.top-150&&after.top>upEnd.top+150)
    result.wheel={completed:!interrupted&&actualDirection&&after.gap<=2,before,upEnd,after,actualDirection,events,scrollTrace,frames:await ui.evaluate(`cancelAnimationFrame(frameVisible);framesVisible`),receivedUpdates:await ui.evaluate('receivedUpdates'),scriptMs:(mAfter.ScriptDuration-mBefore.ScriptDuration)*1000,layoutMs:(mAfter.LayoutDuration-mBefore.LayoutDuration)*1000}
    assert.ok(result.wheel.completed,'Visible native-target wheel movement incomplete')
  }else result.wheel={completed:false,events:[],reason:'Stable visible page unavailable without foreground activation; no wheel dispatched'}
  result.correctness=await correctness();result.rendererErrors=errors;result.ok=errors.length===0
}catch(error){result.ok=false;result.failure=error.stack}
finally{
  if(main)await main.evaluate(`if(globalThis.bgTimer)clearInterval(bgTimer);true`).catch(()=>{});
  if(ui)result.visibilityTimeline=await ui.evaluate(`window.visibilityTimeline??[]`).catch(()=>[])
  if(main)result.windowTimeline=await main.evaluate(`clearInterval(globalThis.windowSampler);windowTimeline??[]`).catch(()=>[])
  await main?.evaluate(`setTimeout(()=>e.app.quit(),0);true`).catch(()=>{});for(const s of sockets)s.close();for(let i=0;i<150&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');result.forcedExit=true;result.ok=false}result.exit={code:child.exitCode,signal:child.signalCode};await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(evidence,'electron.log'),logs);console.log(JSON.stringify({ok:result.ok,visibilityGate:result.visibilityGate?.passed,wheel:result.wheel?.completed,correctness:result.correctness?.map(x=>x.name),failure:result.failure,evidence,exit:result.exit}));process.exitCode=result.ok?0:1
}
