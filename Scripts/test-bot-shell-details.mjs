/** Real visible Electron, native menus, trusted Chromium input, isolated storage. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'

const repo=process.cwd(), root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-bot-shell-'))
const evidence=path.resolve(process.env.BLINKY_SHELL_EVIDENCE||path.join(root,'evidence'))
const data=path.join(root,'data'), home=path.join(root,'home'), workspace=path.join(root,'workspace')
for(const dir of [evidence,home,workspace,...['bots','sessions','tasks','memory','browsers/legacy'].map(x=>path.join(data,x))]) await fs.mkdir(dir,{recursive:true})
const fake=path.join(root,'fake-codex.cjs')
await fs.writeFile(fake,String.raw`#!/usr/bin/env node
const a=process.argv.slice(2),send=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(a.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}
if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{}});
else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'gpt-fixture',displayName:'GPT fixture',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{model:'gpt-long-fixture-name',displayName:'GPT longer fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}});
else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:'user',approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:false},thread:{id:'fixture-thread'}}});
else if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'fixture-turn'}}});send({method:'item/started',params:{item:{id:'fixture-message',type:'agentMessage',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'fixture-message',delta:'Synthetic reply'}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed',items:[]}}}),30)}
else send({id:r.id,result:{}})
});
`);await fs.chmod(fake,0o700)
const backends=Object.fromEntries(['claude','grok','opencode','kimi','pi','droid','openai','anthropic','openrouter','xai','ollama','lmstudio'].map(id=>[id,{enabled:false,added:false}]))
backends.codex={enabled:true,added:true,command:fake,extraArgs:[]}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'dark',language:'zh-CN',vibrant:false,defaultBackendId:'codex',defaultModelId:'gpt-fixture',memoryExtraction:'off',backends}))
const old={id:'legacy',name:'Legacy Turtle',description:'Synthetic bot',systemPrompt:'Synthetic fixture',emoji:'TURTLE',color:'#8c8580',backendId:'codex',modelId:'gpt-fixture',thinking:'medium',executionAgent:{backendId:'codex',modelId:'gpt-fixture',thinking:'high'},followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1,activeConversationId:'retained-chat'}
await fs.writeFile(path.join(data,'bots','legacy.json'),JSON.stringify(old))
await fs.writeFile(path.join(data,'bots','other.json'),JSON.stringify({...old,id:'other',name:'Other Bot',emoji:'OTHER',activeConversationId:'other-chat',createdAt:2}))
for(const [id,botId,text] of [['retained-chat','legacy','RETAINED_HISTORY'],['other-chat','other','OTHER_HISTORY']]) await fs.writeFile(path.join(data,'sessions',id+'.json'),JSON.stringify({id,title:text,cwd:workspace,mode:'agent',botIds:[botId],activeBotId:botId,createdAt:1,updatedAt:1,todos:[],messages:[{id:'msg-'+id,role:'user',content:text,createdAt:1}]}))
await fs.writeFile(path.join(workspace,'keep.txt'),'USER_WORKING_FILE')
await fs.writeFile(path.join(data,'browsers/legacy','keep.txt'),'BROWSER_DATA')
await fs.writeFile(path.join(data,'memory/legacy.json'),JSON.stringify({botId:'legacy',entries:[{id:'memory-1',text:'Synthetic Bot memory',createdAt:1}]}))
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
const deleteTrigger='#ob-bot-details .ob-bot-editor-foot > .ob-btn-ghost'
const confirmDelete='#ob-bot-details .ob-bot-confirm .ob-btn-danger'
const cancelDelete='#ob-bot-details .ob-bot-confirm .ob-btn:not(.ob-btn-danger)'
const savedId='legacy'
try{
 launch();await connect();result.window=await native('return {bounds:win.getBounds(),visible:win.isVisible(),userData:app.getPath("userData"),version:process.versions.electron}')
 assert.equal(result.window.userData,data);assert.equal(result.window.visible,true);check('visible-isolated-window')
 await click('.ob-side-item-main[aria-label="Legacy Turtle"]');await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Legacy Turtle')`)
 assert.match(await evaluate(`document.querySelector('.ob-header-bot-trigger .ob-avatar').textContent`),/TURTLE/)
 await key('f','KeyF',4);await wait(`document.activeElement?.classList.contains('ob-side-search-input')`)
 await renderer.cmd('Input.insertText',{text:'Turtle'});await key('Escape');assert.equal(await evaluate(`document.activeElement.value`),'');check('cmd-f-search-escape')
 await key('\\','Backslash',4);await wait(`!document.querySelector('.ob-sidebar') && document.activeElement?.id==='ob-prompt'`)
 await key('f','KeyF',4);await wait(`!!document.querySelector('.ob-sidebar') && document.activeElement?.classList.contains('ob-side-search-input')`)
 await key('l','KeyL',4);await wait(`document.activeElement?.id==='ob-prompt'`);check('sidebar-hide-focus-and-cmd-l')
 result.menu={sidebar:await menu('Toggle Sidebar')};await wait(`!document.querySelector('.ob-sidebar')`);await menu('Find Bot');await wait(`document.activeElement?.classList.contains('ob-side-search-input')`);await menu('Focus Message');await wait(`document.activeElement?.id==='ob-prompt'`);check('native-menu-navigation')
 result.menu.editRoles=await native(`return Menu.getApplicationMenu().items.flatMap(x=>x.submenu?.items??[]).filter(x=>['undo','redo','cut','copy','paste','selectall'].includes(x.role)).map(x=>x.role)`);assert.equal(result.menu.editRoles.length,6)
 await fill('#ob-prompt','draft');await key('a','KeyA',4);assert.equal(await evaluate(`document.querySelector('#ob-prompt').selectionEnd-document.querySelector('#ob-prompt').selectionStart`),5);await renderer.cmd('Input.insertText',{text:'replacement'});assert.equal(await evaluate(`document.querySelector('#ob-prompt').value`),'replacement');check('native-edit-roles-and-chromium-select-all')
 await key('k','KeyK',4);await wait(`!!document.querySelector('.ob-palette-input')`);await key('Escape');await wait(`!document.querySelector('.ob-palette-input')`);check('palette-escape')
 await focus('.ob-side-profile');await key('Enter');await wait(`document.activeElement?.getAttribute('role')==='menuitem'`);await key('End');assert.equal(await evaluate(`document.activeElement.textContent.trim()`),await evaluate(`[...document.querySelectorAll('.ob-side-popover [role=menuitem]')].at(-1).textContent.trim()`));await key('Escape');await wait(`document.activeElement?.classList.contains('ob-side-profile')`);check('account-menu-keyboard-return')
 await click('.ob-header-bot-trigger');await wait(`document.activeElement?.getAttribute('aria-label')==='关闭 Bot 详情'`)
 const rows='#ob-bot-details .ob-bot-runtime-grid'
 await wait(`document.querySelectorAll('${rows} select').length===6`)
 for(const theme of ['dark','light']){
   await evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`);await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
   for(const width of [1200,900,720]){
     await native(`win.setBounds({width:${width},height:820});return true`);await delay(200)
     const layout=await evaluate(`(()=>{const rows=[...document.querySelectorAll('${rows}')].map(row=>{const controls=[...row.querySelectorAll('select')].map(el=>({rect:el.getBoundingClientRect().toJSON(),label:el.getAttribute('aria-label'),value:el.value}));return {width:row.clientWidth,scroll:row.scrollWidth,controls}});return {width:innerWidth,rows,sidebar:getComputedStyle(document.querySelector('.ob-sidebar')).backgroundColor,search:getComputedStyle(document.querySelector('.ob-side-search')).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
     assert.equal(layout.width,width);assert.equal(layout.overflow,false);for(const row of layout.rows){assert.ok(row.scroll<=row.width+1);assert.equal(new Set(row.controls.map(x=>Math.round(x.rect.top))).size,1);for(const c of row.controls){assert.ok(c.rect.width>15);assert.ok(c.label)}}
     assert.equal(layout.sidebar,'rgba(0, 0, 0, 0)');assert.equal(layout.search,'rgba(0, 0, 0, 0)');result.layouts.push({theme,...layout});await screenshot(`${theme}-${width}.png`)
   }
 }
 check('single-row-models-light-dark-720-900-1200')
 await native('win.setBounds({width:1200,height:820});return true');await delay(150)
 await click('#ob-bot-details .ob-bot-editor-disclosure > summary');assert.equal(await evaluate(`document.querySelectorAll('#ob-bot-details input[aria-label*=emoji],#ob-bot-details .ob-bot-emoji-input').length`),0)
 await fill('#ob-bot-name','Legacy Renamed')
 const selects=await evaluate(`Array.from(document.querySelectorAll('${rows}')).map(row=>Array.from(row.querySelectorAll('select')).map(x=>Array.from(x.options).map(o=>({value:o.value,label:o.text,disabled:o.disabled}))))`);result.selects=selects
 // macOS popup menus live outside CDP's renderer input route. Interactive
 // acceptance uses the OS input driver; unattended regression changes the
 // actual select through DOM events and records that narrower input boundary.
 if(process.env.BLINKY_SHELL_NATIVE_SELECT==='1'){
   result.modelInputMode='native-computer-use'
   await focus(`${rows} .ob-bot-runtime-model select`)
   await fs.writeFile(path.join(evidence,'native-select-ready.json'),JSON.stringify({pid:child.pid,data,root}))
   const end=Date.now()+300000
   while(!await evaluate(`(()=>{const r=document.querySelector('${rows}');return r.querySelector('.ob-bot-runtime-model select').value==='gpt-long-fixture-name'&&r.querySelector('.ob-bot-runtime-depth select').value==='high'})()`)){
     if(Date.now()>end)throw Error('Native model/depth selection did not arrive')
     await delay(100)
   }
 }else{
   result.modelInputMode='DOM-change-events'
   for(const [selector,value] of [[`${rows} .ob-bot-runtime-model select`,'gpt-long-fixture-name'],[`${rows} .ob-bot-runtime-depth select`,'high']]){
     await evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
   }
 }
 const selection=await evaluate(`Array.from(document.querySelectorAll('${rows}')).map(row=>Array.from(row.querySelectorAll('select')).map(x=>x.value))`);result.selection=selection
 assert.equal(selection[0][1],'gpt-long-fixture-name');assert.equal(selection[0][2],'high');assert.equal(selection[1][1],'gpt-fixture');assert.equal(selection[1][2],'high')
 await screenshot('models-changed.png');await click('#ob-bot-details .ob-bot-editor-save .ob-btn-primary');await wait(`window.openbot.bots.get('legacy').then(b=>b.name==='Legacy Renamed')`)
 let bot=await evaluate(`window.openbot.bots.get('legacy')`);assert.equal(bot.emoji,'TURTLE');assert.equal(bot.avatarShape,undefined);assert.equal(bot.modelId,selection[0][1]);assert.equal(bot.thinking||'',selection[0][2]);assert.equal(bot.executionAgent.modelId,selection[1][1]);assert.equal(bot.executionAgent.thinking||'',selection[1][2]);result.saved={modelId:bot.modelId,thinking:bot.thinking,executionAgent:bot.executionAgent};check('changed-model-selection-save-legacy-preserved')
 await click(deleteTrigger);await wait(`document.activeElement===document.querySelector('${cancelDelete}')`);assert.match(await evaluate(`document.querySelector('.ob-bot-confirm small').textContent`),/Legacy Renamed/);await key('Escape');await wait(`!document.querySelector('.ob-bot-confirm') && document.activeElement===document.querySelector('${deleteTrigger}')`)
 await click(deleteTrigger);await click(cancelDelete);assert.ok(await evaluate(`window.openbot.bots.get('legacy')`));check('delete-two-stage-cancel-escape-focus')
 await key('Escape');await wait(`!document.querySelector('#ob-bot-details') && document.activeElement?.classList.contains('ob-header-bot-trigger')`);check('details-escape-return-focus')
 await key(',','Comma',4);await wait(`!!document.querySelector('.ob-set')`);await key('Escape');await wait(`!document.querySelector('.ob-set')`);check('settings-shortcut')
 await click('[aria-label="Create a bot"]');await wait(`!!document.querySelector('#ob-create-bot-name')`);await fill('#ob-create-bot-name','Unsaved Draft');await key(',','Comma',4);await delay(80);assert.equal(await evaluate(`document.querySelector('#ob-create-bot-name')?.value`),'Unsaved Draft');await menu('Settings…');await delay(80);assert.equal(await evaluate(`document.querySelector('#ob-create-bot-name')?.value`),'Unsaved Draft');await key('Escape');await wait(`!document.querySelector('#ob-create-bot-name')`);check('modal-draft-protected-from-settings')
 await stop();launch();await connect();bot=await evaluate(`window.openbot.bots.get('${savedId}')`);assert.equal(bot.name,'Legacy Renamed');assert.equal(bot.emoji,'TURTLE');assert.deepEqual({modelId:bot.modelId,thinking:bot.thinking,executionAgent:bot.executionAgent},result.saved);check('save-survives-real-restart')
 await click('.ob-side-item-main[aria-label="Legacy Renamed"]');await click('.ob-header-bot-trigger');await wait(`!!document.querySelector('#ob-bot-details')`)
 // A real filesystem failure must keep the editor and history, then permit retry.
 const botFile=path.join(data,'bots/legacy.json');await fs.rename(botFile,botFile+'.saved');await fs.mkdir(botFile)
 await click(deleteTrigger);await click(confirmDelete);await wait(`!!document.querySelector('.ob-toast.is-error,.ob-toast-error,[role=alert]') && !document.querySelector('${confirmDelete}').disabled`);assert.ok(await evaluate(`window.openbot.bots.get('legacy')`));assert.ok(await evaluate(`window.openbot.sessions.get('retained-chat').then(s=>s.botIds.includes('legacy'))`));await screenshot('delete-failure.png');await fs.rmdir(botFile);await fs.rename(botFile+'.saved',botFile);check('real-delete-failure-retains-editor-history')
 await click(confirmDelete);await wait(`window.openbot.bots.get('legacy').then(b=>b===null)`);await wait(`!document.querySelector('#ob-bot-details .ob-bot-confirm')`);await wait(`document.activeElement!==document.body && document.activeElement?.isConnected`);check('delete-success-focus-has-persistent-target')
 const history=await evaluate(`window.openbot.sessions.get('retained-chat')`);assert.equal(history.messages[0].content,'RETAINED_HISTORY');assert.equal(history.botIds.includes('legacy'),false);assert.ok(await evaluate(`window.openbot.bots.get('other')`));assert.equal(await fs.readFile(path.join(workspace,'keep.txt'),'utf8'),'USER_WORKING_FILE');assert.equal(await fs.readFile(path.join(data,'browsers/legacy/keep.txt'),'utf8'),'BROWSER_DATA');check('real-delete-retains-history-other-bot-files-profile')
 await stop();launch();await connect();assert.equal(await evaluate(`window.openbot.bots.get('legacy')`),null);assert.equal(await evaluate(`window.openbot.sessions.get('retained-chat').then(s=>s.messages[0].content)`),'RETAINED_HISTORY');await assert.rejects(fs.access(path.join(data,'memory/legacy.json')));check('delete-and-memory-removal-survive-restart')
 await click('.ob-side-item-main[aria-label="Other Bot"]');await click('.ob-header-bot-trigger');await wait(`!!document.querySelector('#ob-bot-details')`);await click(deleteTrigger);await click(confirmDelete);await wait(`window.openbot.bots.list().then(b=>b.length===0)`);await stop();launch();await connect();assert.deepEqual(await evaluate('window.openbot.bots.list()'),[]);check('last-delete-does-not-reseed-on-restart')
 assert.deepEqual(errors,[]);result.rendererErrors=errors;result.passed=true
 result.bundleHashes={};for(const file of ['out/main/index.js','out/preload/index.cjs',...((await fs.readdir('out/renderer/assets')).filter(x=>/^index-.*\.(js|css)$/.test(x)).map(x=>'out/renderer/assets/'+x))])result.bundleHashes[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex')
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:result.checks,root,evidence}))
}catch(error){await screenshot('failure.png').catch(()=>{});await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,root,checks:result.checks,errors,logs:logs.slice(-6000)},null,2));throw error}
finally{await stop();await fs.writeFile(path.join(evidence,'electron.log'),logs)}
