/** Synthetic user-profile acceptance in the real Electron app. No OS input driver or native picker interaction. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-user-profile-'))
const evidence=path.resolve(process.env.BLINKY_PROFILE_EVIDENCE||path.join(root,'evidence'))
const data=path.join(root,'data'),home=path.join(root,'home')
for(const dir of [evidence,home,path.join(data,'bots'),path.join(data,'sessions')])await fs.mkdir(dir,{recursive:true})
const backends=Object.fromEntries(['codex','claude','grok','opencode','kimi','pi','droid','openai','anthropic','openrouter','xai','ollama','lmstudio'].map(id=>[id,{enabled:false,added:false}]))
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'dark',language:'zh-CN',vibrant:false,memoryExtraction:'off',profileName:'Legacy User',profileEmoji:'L',profileColor:'#123456',denylist:['keep-profile-rule'],backends}))
const bot={id:'bot',name:'Synthetic Bot',description:'test',systemPrompt:'test',emoji:'B',color:'#889988',backendId:'codex',modelId:'default',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},activeConversationId:'chat',createdAt:1,updatedAt:1}
await fs.writeFile(path.join(data,'bots/bot.json'),JSON.stringify(bot));await fs.writeFile(path.join(data,'sessions/chat.json'),JSON.stringify({id:'chat',title:'Synthetic',cwd:root,mode:'agent',botIds:['bot'],activeBotId:'bot',createdAt:1,updatedAt:1,todos:[],messages:[{id:'fixture',role:'user',content:'Synthetic history',createdAt:1}]}))
function png(width=600,height=240){
 const chunk=(name,bytes)=>{const type=Buffer.from(name),body=Buffer.concat([type,bytes]);let crc=0xffffffff;for(const v of body){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2
 const raw=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(1+width*3)+1+x*3;raw[i]=x%256;raw[i+1]=y%256;raw[i+2]=180}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('tEXt',Buffer.from('Comment\0PRIVATE_FIXTURE_METADATA')),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}
const imageFile=path.join(root,'synthetic-photo.png'),badFile=path.join(root,'unreadable.png'),largeFile=path.join(root,'oversize.png'),svgFile=path.join(root,'unsupported.svg')
const wideFile=path.join(root,'too-wide.png')
await fs.writeFile(imageFile,png());await fs.writeFile(wideFile,png(4097,1));await fs.writeFile(badFile,'not an image');await fs.writeFile(largeFile,Buffer.alloc(5*1024*1024+1));await fs.writeFile(svgFile,'<svg xmlns="http://www.w3.org/2000/svg"/>')
const port=async()=>{const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)});const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
const rendererPort=await port(), mainPort=await port()
const executable=await fs.realpath(path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
let child,renderer,main,logs='',errors=[]
const result={realElectron:true,visibleWindow:true,realModel:false,root,data,repo,executable,checks:[],layouts:[]}
const check=(name)=>result.checks.push(name)
function launch(){child=spawn(executable,['.',`--remote-debugging-port=${rendererPort}`,`--inspect=127.0.0.1:${mainPort}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x)}
async function connection(port,kind){let target;for(let i=0;i<250;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>!kind||t.type===kind);if(target)break}catch{}if(child?.exitCode!==null)throw Error('Electron exited '+logs.slice(-1600));await delay(100)}if(!target)throw Error('Missing inspector target '+logs.slice(-1600));const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});let seq=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)};return{socket,cmd:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})}}
async function evaluate(expression,connection=renderer){const r=await connection.cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<200;i++){if(await evaluate(expression))return;await delay(50)}throw Error('Timeout '+expression+'\n'+await evaluate('document.body.innerText.slice(-1200)'))}
const electron=`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron')`
const native=expression=>evaluate(`(()=>{const {app,BrowserWindow,Menu}=${electron};const win=BrowserWindow.getAllWindows()[0];${expression}})()`,main)
async function connect(){renderer=await connection(rendererPort,'page');main=await connection(mainPort);await renderer.cmd('Runtime.enable');await wait(`!!document.querySelector('#ob-prompt')`);await native('win.show();win.focus();return {visible:win.isVisible(),focused:win.isFocused()}')}
async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await renderer.cmd('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await renderer.cmd('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1})}
async function key(key,code=key,modifiers=0){const vk={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Home:36,End:35,' ':32,'\\':220,',':188}[key]??(key.length===1?key.toUpperCase().charCodeAt(0):0);await renderer.cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers,windowsVirtualKeyCode:vk,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}),...(modifiers===4&&key==='a'?{commands:['selectAll']}:{})});await renderer.cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers,windowsVirtualKeyCode:vk})}
async function focus(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)}
async function fill(selector,text){await focus(selector);await key('a','KeyA',4);await renderer.cmd('Input.insertText',{text})}
async function menu(command){return native(`const wanted=${JSON.stringify(command)};const find=items=>{for(const x of items){if(x.label===wanted||('@'+x.role)===wanted)return x;if(x.submenu){const f=find(x.submenu.items);if(f)return f}}};const item=find(Menu.getApplicationMenu().items);if(!item)throw Error('Missing menu item '+wanted);item.click(item,win,{});return {label:item.label,accelerator:item.accelerator,role:item.role}`)}
async function screenshot(name){await delay(100);const shot=await renderer.cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name),Buffer.from(shot.data,'base64'))}
async function stop(){renderer?.socket.close();main?.socket.close();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(2500)]);if(child.exitCode===null)child.kill('SIGKILL')}}
process.once('SIGTERM',async()=>{await stop();process.exit(143)})
const profile='.ob-user-profile',nameInput='[data-profile-name]',fileInput='[data-profile-file]'
const submit=`${profile} button[type=submit]`,cancel=`${profile} .ob-user-profile-actions button[type=button]`
async function openProfile(){
 await focus('.ob-side-profile');await key('Enter');await wait(`!!document.querySelector('.ob-side-popover') && document.activeElement?.getAttribute('role')==='menuitem'`)
 await key('Enter');await wait(`!!document.querySelector('${profile}')`)
}
async function upload(file){
 const {root:doc}=await renderer.cmd('DOM.getDocument')
 const {nodeId}=await renderer.cmd('DOM.querySelector',{nodeId:doc.nodeId,selector:fileInput})
 await renderer.cmd('DOM.setFileInputFiles',{nodeId,files:file?[file]:[]})
}
const read=()=>evaluate('window.openbot.settings.get()')
const identity=b=>({id:b.id,name:b.name,emoji:b.emoji,avatarShape:b.avatarShape,avatarColor:b.avatarColor,backendId:b.backendId,tools:b.tools})
result.nativePicker='not-driven; synthetic files selected through isolated DOM input'
try{
 launch();await connect()
 result.window=await native('return {visible:win.isVisible(),bounds:win.getBounds(),userData:app.getPath("userData"),version:process.versions.electron}')
 assert.equal(result.window.userData,data);assert.equal(result.window.visible,true)
 const botBefore=identity(await evaluate(`window.openbot.bots.get('bot')`))
 assert.equal(await evaluate(`document.querySelector('.ob-side-profile > span:last-child').textContent`),'Legacy User')
 assert.equal(await evaluate(`document.querySelector('.ob-side-profile .ob-user-avatar').textContent`),'L')
 assert.equal(await evaluate(`!!document.querySelector('.ob-side-profile img')`),false);check('legacy-user-identity-fallback')
 await openProfile();assert.equal(await evaluate(`document.querySelector('${nameInput}').value`),'Legacy User')
 await upload(null);assert.equal((await read()).profileImage,'');check('cancelled-file-selection-is-noop')
 await fill(nameInput,'Draft User');await upload(imageFile)
 await wait(`document.querySelector('${profile} img')?.naturalWidth===256`)
 assert.equal(await evaluate(`document.querySelector('.ob-side-profile > span:last-child').textContent`),'Legacy User')
 await click(cancel);await wait(`document.querySelector('${nameInput}').value==='Legacy User' && !document.querySelector('${profile} img')`)
 assert.equal((await read()).profileName,'Legacy User');check('draft-photo-name-cancel-does-not-save')
 for(const invalid of [badFile,largeFile,svgFile,wideFile]){
   await upload(invalid);await wait(`!!document.querySelector('${profile} [role=alert]')`)
   assert.equal((await read()).profileName,'Legacy User');assert.equal((await read()).profileImage,'')
 }
 check('decode-size-and-unsupported-image-errors-preserve-identity')
 await fill(nameInput,'  Reader User  ');await upload(imageFile);await wait(`document.querySelector('${profile} img')?.naturalWidth===256`)
 for(const theme of ['light','dark']){
   await evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`)
   await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
   for(const width of [1200,720]){
     await native(`win.setBounds({width:${width},height:820});return true`);await delay(100)
     const layout=await evaluate(`(()=>{const r=document.querySelector('${profile}');return {width:innerWidth,formWidth:r.clientWidth,formScroll:r.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
     assert.equal(layout.width,width);assert.equal(layout.overflow,false);assert.ok(layout.formScroll<=layout.formWidth+1);result.layouts.push({theme,...layout});await screenshot(`profile-${theme}-${width}.png`)
   }
 }
 check('profile-theme-and-720-1200-layout')
 await native('win.setBounds({width:1200,height:820});return true');await click(submit)
 await wait(`document.querySelector('${profile} [role=status]')?.textContent.includes('已保存')`)
 await wait(`document.querySelector('.ob-side-profile > span:last-child').textContent==='Reader User' && document.querySelector('.ob-side-profile img')?.naturalWidth===256`)
 let settings=await read(),disk=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'))
 assert.equal(disk.profileName,'Reader User');assert.equal(settings.profileName,disk.profileName);assert.equal(disk.profileImage,settings.profileImage)
 const photo=settings.profileImage,bytes=Buffer.from(photo.slice(22),'base64')
 assert.equal(bytes.includes(Buffer.from('PRIVATE_FIXTURE_METADATA')),false);assert.equal(photo.startsWith('data:image/png;base64,'),true);assert.ok(photo.length<400000)
 assert.equal(settings.profileEmoji,'L');assert.equal(settings.profileColor,'#123456');assert.deepEqual(settings.denylist,['keep-profile-rule']);assert.deepEqual(identity(await evaluate(`window.openbot.bots.get('bot')`)),botBefore)
 assert.equal(await evaluate(`document.querySelector('${profile} img').src===document.querySelector('.ob-side-profile img').src`),true)
 result.image={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};check('real-image-normalisation-durable-save-and-all-identity-views')
 await focus(nameInput);await key('Tab');assert.ok(await evaluate(`!!document.activeElement?.closest('${profile}')`));await fill(nameInput,'Abandoned');await key('Escape');await wait(`!document.querySelector('${profile}')`);assert.equal((await read()).profileName,'Reader User');check('keyboard-escape-discards-without-blur-save')
 await openProfile();await fill(nameInput,'   ');await focus(nameInput);await key('Enter');await wait(`document.querySelector('.ob-side-profile > span:last-child').textContent==='个人资料'`);assert.equal((await read()).profileName,'');check('empty-name-clears-to-profile-label')
 await fill(nameInput,'Reader Restored');await click(submit);await wait(`document.querySelector('.ob-side-profile > span:last-child').textContent==='Reader Restored'`)
 const settingsFile=path.join(data,'settings.json');await fs.rename(settingsFile,settingsFile+'.saved');await fs.mkdir(settingsFile)
 await fill(nameInput,'Storage Retry');await click(submit);await wait(`!!document.querySelector('${profile} [role=alert]') && !document.querySelector('${submit}').disabled`)
 assert.equal((await read()).profileName,'Reader Restored');assert.equal(await evaluate(`document.querySelector('.ob-side-profile > span:last-child').textContent`),'Reader Restored')
 await screenshot('profile-save-failure.png');await fs.rmdir(settingsFile);await fs.rename(settingsFile+'.saved',settingsFile);await click(submit)
 await wait(`document.querySelector('.ob-side-profile > span:last-child').textContent==='Storage Retry'`);check('actual-disk-failure-keeps-saved-identity-and-retries')
 const rejected=await evaluate(`window.openbot.settings.saveProfile({profileName:'Bad',profileImage:'https://invalid.example/photo.png'})`);assert.equal(rejected.ok,false);assert.equal((await read()).profileName,'Storage Retry');check('main-boundary-rejects-remote-avatar')
 await evaluate(`Promise.all([window.openbot.settings.saveProfile({profileName:'Concurrent User',denylist:['overwrite']}),...Array.from({length:8},(_,i)=>window.openbot.settings.update({theme:i%2?'light':'dark'}))])`)
 settings=await read();assert.equal(settings.profileName,'Concurrent User');assert.equal(settings.theme,'light');assert.deepEqual(settings.denylist,['keep-profile-rule']);check('concurrent-settings-and-profile-scope-preserved')
 await evaluate(`document.querySelector('.ob-side-profile img').dispatchEvent(new Event('error'))`);await wait(`!document.querySelector('.ob-side-profile img')`);assert.equal((await read()).profileImage,photo);check('image-render-failure-falls-back-without-clearing-saved-photo')
 await stop();launch();await connect();await wait(`document.querySelector('.ob-side-profile img')?.naturalWidth===256`)
 settings=await read();assert.equal(settings.profileName,'Concurrent User');assert.equal(settings.profileImage,photo);assert.equal(await evaluate(`document.querySelector('.ob-side-profile > span:last-child').textContent`),'Concurrent User');assert.deepEqual(identity(await evaluate(`window.openbot.bots.get('bot')`)),botBefore);check('real-restart-restores-photo-name-without-changing-bot')
 await openProfile();await click(`${profile} .ob-btn-ghost`);await click(cancel);assert.equal((await read()).profileImage,photo)
 await click(`${profile} .ob-btn-ghost`);await click(submit);await wait(`!document.querySelector('.ob-side-profile img')`);assert.equal((await read()).profileImage,'');assert.equal(await evaluate(`document.querySelector('.ob-side-profile .ob-user-avatar').textContent`),'L');check('photo-removal-cancel-and-save-retain-legacy-fallback')
 await stop();launch();await connect();assert.equal((await read()).profileImage,'');assert.equal((await read()).profileName,'Concurrent User');check('photo-removal-persists-across-restart')
 assert.equal(errors.length,0);result.rendererErrors=errors;result.passed=true
 result.bundleHashes={};for(const f of ['out/main/index.js','out/preload/index.cjs',...((await fs.readdir('out/renderer/assets')).filter(x=>/^index-.*\.(js|css)$/.test(x)).map(x=>'out/renderer/assets/'+x))])result.bundleHashes[f]=createHash('sha256').update(await fs.readFile(f)).digest('hex')
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:result.checks,root,evidence}))
}catch(error){await screenshot('failure.png').catch(()=>{});await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,root,checks:result.checks,errors,logs:logs.slice(-5000)},null,2));throw error}
finally{await stop();await fs.writeFile(path.join(evidence,'electron.log'),logs)}
