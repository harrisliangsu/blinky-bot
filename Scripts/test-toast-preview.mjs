/** Toast regression in a real mounted Preview. Synthetic CLI warnings; no native notification or microphone requests. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-toast-ui-'))
const evidence=path.resolve(process.env.BLINKY_UI_EVIDENCE||path.join(root,'evidence'));await fs.mkdir(evidence,{recursive:true})
const data=path.join(root,'data'),home=path.join(root,'home');for(const d of [home,path.join(data,'bots'),path.join(data,'sessions')])await fs.mkdir(d,{recursive:true})
const result={root,data,repo,checks:[],layouts:[],notifications:[],trigger:'synthetic Codex CLI warning through real backend/main/preload/renderer',nativeInput:'CDP in isolated renderer; native file chooser and Notification Center not driven'}
let progress=Promise.resolve();const check=name=>{result.checks.push(name);progress=progress.then(()=>fs.writeFile(path.join(evidence,'progress.json'),JSON.stringify(result,null,2)+'\n'))}
const modeFile=path.join(root,'model-mode'),modelTrace=path.join(root,'model-trace.jsonl'),fakeCli=path.join(root,'fake-codex.cjs')
await fs.writeFile(modeFile,'ok')
await fs.writeFile(fakeCli,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),modeFile=${JSON.stringify(modeFile)},trace=${JSON.stringify(modelTrace)},send=x=>console.log(JSON.stringify(x));
if(a.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}
if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
let seq=0,thread='fixture-thread-'+process.pid,timer,active;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),str=JSON.stringify(r.params||{});fs.appendFileSync(trace,JSON.stringify({method:r.method,model:r.params?.model,personaSeen:str.includes('Reply briefly. Never use tools.'),userSeen:str.includes('Synthetic normal reply'),legacySeen:str.includes('legacy-hidden-rule-fixture')})+'\\n');
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'fixture',displayName:'Synthetic fixture',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params?.approvalsReviewer??'user',approvalPolicy:r.params?.approvalPolicy??'never',sandbox:{type:r.params?.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false},thread:{id:thread}}});
 else if(r.method==='turn/interrupt'){clearTimeout(timer);send({id:r.id,result:{}});if(active)send({method:'turn/completed',params:{threadId:thread,turn:{id:active,status:'interrupted',items:[]}}})}
 else if(r.method==='turn/start'){
  const mode=fs.readFileSync(modeFile,'utf8'),id='fixture-turn-'+(++seq),item='fixture-message-'+seq;active=id;send({id:r.id,result:{turn:{id}}});
  if(mode==='error'){send({method:'turn/completed',params:{threadId:thread,turn:{id,status:'failed',error:{message:'Synthetic failure'},items:[]}}});return}
  if(mode!=='empty'){send({method:'item/started',params:{threadId:thread,turnId:id,item:{id:item,type:'agentMessage',phase:'final_answer',text:''}}});if(mode!=='slow-ok')send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:id,itemId:item,delta:mode==='delay'?'合成片段':'合成回复完成。'}})}
  timer=setTimeout(()=>{if(mode==='slow-ok')send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:id,itemId:item,delta:'合成回复完成。'}});send({method:'warning',params:{threadId:thread,message:mode==='long'?'资料暂时无法同步，请稍后重试。'+(' 合成测试详细信息'.repeat(180)):'Synthetic native warning: reply completed. 状态提示仍可见。'}});send({method:'turn/completed',params:{threadId:thread,turn:{id,status:'completed',items:[]}}});active=undefined},mode==='delay'?2500:mode==='slow-ok'?600:30)
 } else if(r.id!==undefined)send({id:r.id,result:{}})
});
`);await fs.chmod(fakeCli,0o700)
async function setMode(value){await fs.writeFile(modeFile,value)}
const backend='codex',backends=Object.fromEntries(['codex','claude','grok','opencode','kimi','pi','droid','openai','anthropic','openrouter','xai'].map(id=>[id,{enabled:false,added:false}]))
backends[backend]={enabled:true,added:true,command:fakeCli,extraArgs:[],defaultModelId:'fixture'}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'dark',language:'zh-CN',vibrant:false,memoryExtraction:'off',notifications:false,notifyOnTurn:false,voiceLanguage:'zh-CN',defaultBackendId:backend,defaultModelId:'fixture',backends,quickDecision:{backendId:backend,modelId:'legacy-router-fixture'},rules:'legacy-hidden-rule-fixture'}))
for(const [id,name] of [['bot','合成 Bot'],['other','第二 Bot']]){
 await fs.writeFile(path.join(data,`bots/${id}.json`),JSON.stringify({id,name,description:'仅测试资料，不代表运行状态',systemPrompt:'Reply briefly. Never use tools.',emoji:'B',color:'#889988',backendId:backend,modelId:'fixture',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},activeConversationId:id==='bot'?'chat':'chat-other',createdAt:1,updatedAt:1}))
 const sid=id==='bot'?'chat':'chat-other';await fs.writeFile(path.join(data,`sessions/${sid}.json`),JSON.stringify({id:sid,title:name+'的历史对话',cwd:root,mode:'agent',botIds:[id],activeBotId:id,createdAt:1,updatedAt:1,todos:[],messages:[{id:'fixture-'+id,role:'user',content:'Synthetic history',createdAt:1}]}))
}
const port=async()=>{const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
const rendererPort=await port(),mainPort=await port()
const executable=process.env.BLINKY_PREVIEW_EXECUTABLE
assert.ok(executable?.startsWith('/private/tmp/')&&executable.includes('.app/Contents/MacOS/'),'Provide the isolated mounted Preview executable')
let child,renderer,main,logs='',errors=[]
function launch(){child=spawn(executable,[`--remote-debugging-port=${rendererPort}`,`--inspect=127.0.0.1:${mainPort}`,'--remote-allow-origins=*'],{cwd:repo,env:{PATH:process.env.PATH,HOME:home,TMPDIR:root,SHELL:'/bin/zsh',LANG:'en_US.UTF-8',XDG_CONFIG_HOME:path.join(home,'.config'),BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.on('exit',(code,signal)=>{result.processExit={code,signal};logs+=`\n[owned-child-exit] ${code} ${signal}\n`});child.on('error',e=>{logs+='\n[spawn-error] '+e.message});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x)}
async function connection(port,kind){let target;for(let i=0;i<400;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>!kind||t.type===kind);if(target)break}catch{}if(child?.exitCode!==null||child?.signalCode!==null)throw Error('Electron exited '+logs.slice(-2000));await delay(100)}if(!target)throw Error('Missing inspector target '+logs.slice(-1800));const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});let seq=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)};return{socket,cmd:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timed out: '+method))},20000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});socket.send(JSON.stringify({id,method,params}))})}}
async function evaluate(expression,connection=renderer){const r=await connection.cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(50)}throw Error('Timeout '+expression+'\n'+await evaluate('document.body.innerText.slice(-1700)'))}
const electron=`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron')`
const native=expression=>evaluate(`(()=>{const {app,BrowserWindow,Menu,Notification,ipcMain,dialog,safeStorage}=${electron};const win=BrowserWindow.getAllWindows()[0];${expression}})()`,main)
async function connect(){renderer=await connection(rendererPort,'page');main=await connection(mainPort);await renderer.cmd('Runtime.enable');await wait(`!!document.querySelector('#ob-prompt')`)}
async function point(selector,scroll=true){return evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});if(${scroll})el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)}
function innerSafeX(){return 600}
async function hover(selector){await renderer.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:innerSafeX(),y:400});const p=await point(selector,false);await renderer.cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await delay(160)}
async function click(selector){await native('win.focus();return true');const p=await point(selector);await renderer.cmd('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await renderer.cmd('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await delay(30)}
async function key(key,code=key,modifiers=0){const vk={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38,' ':32,',':188,PageDown:34,End:35}[key]??(key.length===1?key.toUpperCase().charCodeAt(0):0);await renderer.cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:vk,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}),...(modifiers===4&&key==='a'?{commands:['selectAll']}:{})});await renderer.cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode:vk})}
async function focus(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)}
async function fill(selector,text){await focus(selector);await key('a','KeyA',4);await renderer.cmd('Input.insertText',{text});await delay(30)}
async function screenshot(name){const shot=await renderer.cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name),Buffer.from(shot.data,'base64'))}
async function stop(){renderer?.socket.close();main?.socket.close();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(2500)]);if(child.exitCode===null)child.kill('SIGKILL')}}
process.once('SIGTERM',async()=>{await stop();process.exit(143)})
const mic='.ob-composer-right button:first-child',send='.ob-composer-send'
async function openSettings(){await focus('#ob-prompt');await key(',','Comma',4);await wait(`!!document.querySelector('.ob-set')`)}
async function selectTab(tab){await click('#ob-set-tab-'+tab);await wait(`!!document.querySelector('[data-settings-section="${tab}"]')`)}
async function closeSettings(){await key('Escape');await wait(`!document.querySelector('.ob-set')`)}
const read=()=>evaluate('window.openbot.settings.get()')

const before=process.env.BLINKY_TOAST_BEFORE==='1',errorOnly=process.env.BLINKY_TOAST_ERROR_ONLY==='1',focusOnly=process.env.BLINKY_TOAST_FOCUS_ONLY==='1'
const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
const layout=()=>evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};const toast=document.querySelector('.ob-toast'),input=document.querySelector('#ob-prompt'),r=input.getBoundingClientRect();return{toast:rect(toast),input:rect(input),composer:rect(document.querySelector('.ob-composer')),buttons:[...document.querySelectorAll('.ob-composer button')].map(rect),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.className,toastText:toast.textContent,position:getComputedStyle(toast).position,whiteSpace:getComputedStyle(toast.querySelector('.ob-toast-text')).whiteSpace,role:toast.getAttribute('role'),live:toast.getAttribute('aria-live'),parent:toast.parentElement.className,viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth}})()`)
async function reply(noticeMode='ok') {
 await setMode(noticeMode);await fill('#ob-prompt','Synthetic Toast reply '+result.checks.length);await click(send)
 await wait(`!!document.querySelector('.ob-toast-info') && document.body.textContent.includes('合成回复完成。')`)
 await wait(`window.openbot.agent.isRunning('chat').then(r=>!r)`)
}
try{
 launch();await connect()
 result.window=await native('return {visible:win.isVisible(),bounds:win.getBounds(),userData:app.getPath("userData"),appPath:app.getAppPath(),version:process.versions.electron}')
 assert.equal(result.window.userData,data);assert.equal(result.window.visible,true)
 await native(`globalThis.__nativeNotificationCalls=0;Notification.prototype.show=function(){globalThis.__nativeNotificationCalls++;throw Error('System notification calls forbidden in Toast regression')};return true`)
 await click('.ob-side-item-main');await wait(`!!document.querySelector('#ob-prompt')`)
 for(const theme of before?['light']:(errorOnly||focusOnly)?[]:['light','dark']) {
  await evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`);await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
  for(const width of before?[720]:[1200,720]) {
   await native(`win.setBounds({width:${width},height:820});return true`)
   await reply();const box=await layout();result.layouts.push({theme,...box})
   await screenshot(`${before?'before':'after'}-${theme}-${width}-notice.png`)
   await click('#ob-prompt');await renderer.cmd('Input.insertText',{text:'下一条连续输入'});await renderer.cmd('Input.insertText',{text:'，继续编辑。'})
   const value=await evaluate(`document.querySelector('#ob-prompt').value`)
   if(before) {
    result.reproduced={overlap:overlaps(box.toast,box.input),hit:box.hit,typedValue:value,expectedValue:'下一条连续输入，继续编辑。'}
    assert.ok(result.reproduced.overlap);assert.notEqual(value,result.reproduced.expectedValue)
    await screenshot('before-click-blocked.png');check('real-backend-warning-toast-overlaps-input-and-blocks-click')
   } else {
    assert.equal(overlaps(box.toast,box.composer),false);assert.ok(box.buttons.every(b=>!overlaps(box.toast,b)))
    assert.equal(box.hit,'ob-composer-input');assert.equal(value,'下一条连续输入，继续编辑。')
    assert.ok(box.toastText.includes('Synthetic native warning'));assert.equal(box.role,'status');assert.equal(box.live,'polite');assert.equal(box.overflow,false)
    assert.ok(box.toast.left>=0&&box.toast.right<=width&&box.toast.bottom<=820)
    await click('.ob-composer-plus');await wait(`!!document.querySelector('.ob-composer-add-menu')`);await key('Escape');await wait(`!document.querySelector('.ob-composer-add-menu')`)
    assert.ok(await evaluate(`!!document.querySelector('.ob-toast')`),'Toast must remain visible during typing/controls checks')
    assert.equal(await evaluate(`document.querySelector('.ob-composer-right button:first-child').disabled`),false)
    await screenshot(`after-${theme}-${width}-typing-and-controls.png`)
    check(`real-warning-visible-continuous-input-controls-${theme}-${width}`)
   }
  }
 }
 if(!before) {
  await native(`win.setBounds({width:720,height:580});return true`)
  if(!errorOnly) {
  await reply('long');const box=await layout();result.layouts.push({theme:'dark',long:true,...box})
  assert.equal(overlaps(box.toast,box.composer),false);assert.equal(box.overflow,false)
  assert.ok(box.toast.height<=180);assert.ok(box.toast.top>0);assert.ok(box.toastText.includes('资料暂时无法同步'))
  const longText=await evaluate(`(()=>{const e=document.querySelector('.ob-toast-text');return{height:e.clientHeight,scroll:e.scrollHeight,text:e.textContent}})()`)
  assert.ok(longText.scroll>longText.height);result.longText={...longText,text:longText.text.slice(0,100)}
  await click('#ob-prompt');await renderer.cmd('Input.insertText',{text:'长提示仍可输入'});assert.equal(await evaluate(`document.querySelector('#ob-prompt').value`),'长提示仍可输入')
  await key('Tab');await key('Tab');await key('Tab');assert.equal(await evaluate(`document.activeElement.className`),'ob-toast-text');await key('PageDown');await delay(80);assert.ok(await evaluate(`document.querySelector('.ob-toast-text').scrollTop>0`));check('long-status-text-accessible-by-tab-and-keyboard-scroll')
  await screenshot('after-dark-720-long-notice.png');check('long-notice-wraps-scrolls-with-input-and-buttons-visible')
  await key('Tab');await key('Enter');await wait(`!document.querySelector('.ob-toast')`)
  result.keyboardDismissFocus=await evaluate(`({tag:document.activeElement.tagName,className:document.activeElement.className})`);assert.equal(await evaluate(`document.activeElement.matches('.ob-composer-send')`),true);await key('Tab','Tab',8);await key('Tab','Tab',8);assert.equal(await evaluate(`document.activeElement?.id`),'ob-prompt');await renderer.cmd('Input.insertText',{text:'，键盘关闭后继续'});assert.ok((await evaluate(`document.querySelector('#ob-prompt').value`)).endsWith('，键盘关闭后继续'));check('keyboard-dismiss-restores-tab-origin-and-continued-draft')
  await reply();await focus('#ob-prompt');await key(',','Comma',4);await wait(`!!document.querySelector('.ob-set') && !!document.querySelector('.ob-toast')`)
  assert.equal(await evaluate(`document.querySelector('.ob-toast').parentElement.classList.contains('ob-modal')`),true)
  await screenshot('after-toast-inside-settings.png');await key('Escape');await wait(`!document.querySelector('.ob-set')`)
  assert.equal(await evaluate(`document.querySelector('.ob-toast').parentElement.classList.contains('ob-main')`),true);check('notice-follows-active-dialog-and-returns-to-chat')
  }
  // Exercise the real oversized-image error using a synthetic clipboard file.
  await click('#ob-prompt');await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(5_625_003)],'oversized.png',{type:'image/png'}));document.querySelector('#ob-prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`)
  await wait(`!!document.querySelector('.ob-toast-error')`)
  const error=await layout();assert.ok(error.toastText.includes('这张图片太大'));assert.equal(overlaps(error.toast,error.composer),false)
  await renderer.cmd('Input.insertText',{text:'错误提示可见时\n第二行仍能编辑'});assert.equal(await evaluate(`document.querySelector('#ob-prompt').value`),'错误提示可见时\n第二行仍能编辑'.replaceAll('\\n','\n'))
  await screenshot('after-attachment-error-readable.png');check('real-oversized-image-error-remains-readable-and-multiline-input-clear')
  await wait(`!document.querySelector('.ob-toast')`);assert.equal(await evaluate(`document.activeElement.id`),'ob-prompt');await renderer.cmd('Input.insertText',{text:'；消失后继续'});assert.ok((await evaluate(`document.querySelector('#ob-prompt').value`)).endsWith('；消失后继续'));check('natural-toast-expiry-keeps-focus-and-existing-draft')
  if(errorOnly) {
   await reply('long');await click('#ob-prompt');await renderer.cmd('Input.insertText',{text:'Keyboard reading fixture'});await key('Tab');await key('Tab');await key('Tab')
   assert.equal(await evaluate(`document.activeElement.className`),'ob-toast-text')
   await key('PageDown');await delay(80);assert.ok(await evaluate(`document.querySelector('.ob-toast-text').scrollTop>0`));check('long-status-text-accessible-by-tab-and-keyboard-scroll')
  }

 }
 result.nativeNotificationCalls=await native('return globalThis.__nativeNotificationCalls');assert.equal(result.nativeNotificationCalls,0)
 result.speechCapture=false;result.ok=true
}catch(error){result.ok=false;result.error=String(error.stack||error);try{await screenshot('failure.png')}catch{};process.exitCode=1}
finally{result.rendererExceptions=errors;await stop();await progress;await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');await fs.writeFile(path.join(evidence,'electron.log'),logs);console.log(JSON.stringify({ok:result.ok,checks:result.checks,error:result.error,evidence,root},null,2))}
