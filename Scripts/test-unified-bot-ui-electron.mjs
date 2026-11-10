// Run only when the coordinator supplies a frozen Preview executable. This
// owns one temporary profile, one Electron process at a time, and fake CLIs.
// Keyboard input uses BrowserWindow.webContents.sendInputEvent, never DOM
// KeyboardEvent dispatch. No account, real credential, browser Space or send.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'

assert.equal(process.platform, 'darwin', 'The packaged macOS app is required')
const executable = process.env.BLINKY_UNIFIED_EXECUTABLE
assert.ok(executable, 'Set BLINKY_UNIFIED_EXECUTABLE to the frozen Preview executable')
const asar = path.resolve(path.dirname(executable), '../Resources/app.asar')
const metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'))
assert.equal(metadata.blinkyBuildChannel, 'preview', 'This harness must not launch the formal app or modify its login registration')
const asarSha = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
if (process.env.EXPECTED_ASAR_SHA) assert.equal(asarSha, process.env.EXPECTED_ASAR_SHA)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-unified-ui-electron-'))
const data = path.join(root, 'data'), home = path.join(root, 'home'), work = path.join(root, 'work')
const evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence')
for (const directory of [data, home, work, evidence, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(directory, { recursive: true })
const trace = path.join(root, 'fixture-trace.jsonl'), fixture = path.join(root, 'codex-fixture.cjs')
await fs.writeFile(fixture, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline'),trace=${JSON.stringify(trace)};let n=0,t=0;const active=new Map(),parent=process.ppid;
const record=value=>fs.appendFileSync(trace,JSON.stringify({pid:process.pid,...value})+'\\n'),send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(()=>{try{process.kill(parent,0)}catch{process.exit(0)}},300).unref();
if(process.argv.includes('--version')){console.log('codex-cli 0.167.0');process.exit(0)}
if(process.argv[2]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
function finish(thread,status){const a=active.get(thread);if(!a)return;active.delete(thread);send({method:'turn/completed',params:{threadId:thread,turn:{id:a,status}}})}
readline.createInterface({input:process.stdin}).on('line',line=>{let r;try{r=JSON.parse(line)}catch{return}const p=r.params||{};
if(r.method==='initialize')send({id:r.id,result:{}});
else if(r.method==='model/list')send({id:r.id,result:{data:['fixture-lead','fixture-lead-alternate-with-long-name','fixture-agent'].map(model=>({model,displayName:model,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Low'},{reasoningEffort:'high',description:'High'}]})),nextCursor:null}});
else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:p.threadId||'fixture-'+process.pid+'-'+(++n)},approvalPolicy:p.approvalPolicy||'never',approvalsReviewer:p.approvalsReviewer||'user',sandbox:{type:p.sandbox==='danger-full-access'?'dangerFullAccess':p.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false}}});
else if(r.method==='turn/start'){const thread=p.threadId,turn='turn-'+process.pid+'-'+(++t);record({method:r.method,model:p.model,thread,turn});active.set(thread,turn);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
if(p.model!=='fixture-agent'){send({method:'item/started',params:{threadId:thread,item:{type:'agentMessage',id:'answer-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+turn,delta:'Synthetic lead response'}});setTimeout(()=>finish(thread,'completed'),80)}
}else if(r.method==='turn/interrupt'){record({method:r.method,thread:p.threadId});send({id:r.id,result:{}});finish(p.threadId,'interrupted')}
else if(r.id)send({id:r.id,result:{}})
});
`)
await fs.chmod(fixture, 0o700)
const denylist = ['tool:blocked-demo', '*DO_NOT_ACCESS_SYNTHETIC*'], allowlist = ['tool:read_file']
const backends = Object.fromEntries(['codex','claude','claude-code','grok','kimi','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id => [id, { enabled: id === 'codex', command: fixture, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'fixture-lead',approvalPolicy:'ask-every-time',denylist,allowlist,rules:'Synthetic local rules retained',memoryExtraction:'off',notifications:false,notifyOnComplete:false,runRoutinesWhenClosed:false,launchAtLogin:false,backends }))
const botBase = {emoji:'🧪',color:'#878787',description:'Isolated synthetic UI verification',systemPrompt:'Only synthetic responses.',backendId:'codex',modelId:'fixture-lead',thinking:'low',followsDefault:false,executionAgent:{backendId:'codex',modelId:'fixture-agent',thinking:'low'},tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}
for (const [id,name] of [['disposable','Disposable'],['keeper','Keeper']]) {
  await fs.writeFile(path.join(data,'bots',id+'.json'),JSON.stringify({...botBase,id,name,activeConversationId:id+'-home'}))
  await fs.writeFile(path.join(data,'sessions',id+'-home.json'),JSON.stringify({id:id+'-home',title:name+' synthetic home',cwd:work,mode:'agent',botIds:[id],activeBotId:id,messages:[{id:id+'-sentinel',role:'user',content:'SYNTHETIC_HISTORY_MUST_SURVIVE_'+id,createdAt:1}],todos:[],archived:false,createdAt:1,updatedAt:1}))
}
const result = {root,evidence,executable,asarSha256:asarSha,harnessSha256:createHash('sha256').update(await fs.readFile(process.argv[1])).digest('hex'),realElectron:true,realModel:false,fakeCLI:true,isolatedHome:home,isolatedData:data,keyboardInput:'webContents.sendInputEvent',checks:[]}
let app, ui, main, sockets=[],logs='',exceptions=[],exits=[]
const freePort = () => new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
async function connect(port,type) {
  let target
  const end=Date.now()+30000
  while(Date.now()<end){if(app.exitCode!==null||app.signalCode!==null)throw Error('Owned Electron exited before inspector readiness');try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(item=>!type||item.type===type);if(target)break}catch{}await delay(100)}
  assert.ok(target,'Owned inspector endpoint must become ready')
  const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  let seq=0;const pending=new Map()
  ws.onmessage=event=>{const value=JSON.parse(event.data);if(value.method==='Runtime.exceptionThrown')exceptions.push(value.params.exceptionDetails.text);const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(Error(value.error.message)):item.resolve(value.result)}}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector timeout: '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value}
  return {send,evaluate}
}
async function launch() {
  const port=await freePort(),mainPort=await freePort()
  const env=Object.fromEntries(['PATH','USER','LOGNAME','LANG','LC_ALL','SHELL','TMPDIR','__CF_USER_TEXT_ENCODING'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),OPENBOT_DATA_DIR:data,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'})
  app=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--inspect=127.0.0.1:'+mainPort,'--user-data-dir='+path.join(root,'chromium')],{cwd:work,env,stdio:['ignore','pipe','pipe']})
  logs+='\nOWNED_LAUNCH '+app.pid+'\n';app.stdout.on('data',value=>logs+=value);app.stderr.on('data',value=>logs+=value)
  ui=await connect(port,'page');main=await connect(mainPort);await ui.send('Runtime.enable')
  await main.evaluate(`globalThis.__uiElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');globalThis.__uiWindow=__uiElectron.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());__uiElectron.app.focus({steal:true});__uiWindow.focus();__uiWindow.webContents.focus()`)
  const runtime=await main.evaluate(`({pid:process.pid,home:process.env.HOME,userData:__uiElectron.app.getPath('userData'),appPath:__uiElectron.app.getAppPath(),packaged:__uiElectron.app.isPackaged})`)
  assert.equal(runtime.userData,data);assert.equal(runtime.home,home);assert.equal(runtime.appPath,asar);assert.equal(runtime.packaged,true)
  result.launches??=[];result.launches.push(runtime)
  await wait(`!!document.querySelector('#ob-prompt')`)
}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await ui.evaluate(expression);if(value)return value;await delay(80)}throw Error('Timed out: '+expression)}
async function quit() {
  if(!app)return
  const owned=app
  if(owned.exitCode===null&&owned.signalCode===null){await main?.evaluate(`setTimeout(()=>__uiElectron.app.quit(),0);true`).catch(()=>{});for(const s of sockets)s.close();sockets=[];const end=Date.now()+15000;while(Date.now()<end&&owned.exitCode===null&&owned.signalCode===null)await delay(100);if(owned.exitCode===null&&owned.signalCode===null){owned.kill('SIGTERM');throw Error('Owned app did not complete normal shutdown')}}
  exits.push({pid:owned.pid,code:owned.exitCode,signal:owned.signalCode});for(const s of sockets)s.close();sockets=[];app=null
}
async function key(keyCode,modifiers=[]) {
  await main.evaluate(`__uiWindow.webContents.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});__uiWindow.webContents.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});true`)
  await delay(160)
}
async function click(selector) {
  const p=await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  await main.evaluate(`__uiWindow.webContents.sendInputEvent({type:'mouseDown',...${JSON.stringify(p)},button:'left',clickCount:1});__uiWindow.webContents.sendInputEvent({type:'mouseUp',...${JSON.stringify(p)},button:'left',clickCount:1});true`);await delay(180)
}
async function choose(selector,value) {
  // Native macOS popup navigation is outside Chromium keyboard injection.
  // This changes the real control through React's normal change/IPC path;
  // global shortcut verification above still uses trusted native key events.
  result.configurationInput='Real HTML select value setter and change event through React/IPC; not a physical popup-keyboard claim'
  await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||![...e.options].some(o=>o.value===${JSON.stringify(value)}&&!o.disabled))throw Error('Missing or disabled select option');e.focus();Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`)
}
async function shot(name){const s=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(s.data,'base64'))}
const getBot=id=>ui.evaluate(`window.openbot.bots.get(${JSON.stringify(id)})`)
const tasks=()=>ui.evaluate(`window.openbot.tasks.list()`)
async function traceRows(){try{return(await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))}catch{return[]}}
async function deleteClick(){await click('#ob-bot-details .ob-bot-editor-foot .ob-btn-ghost');await click('#ob-bot-details .ob-bot-confirm .ob-btn-danger')}
try {
  await launch()
  await wait(`window.openbot.backends.list().then(items=>items.some(x=>x.id==='codex'&&x.status==='available'))`)
  await ui.evaluate(`window.__uiKeys=[];window.addEventListener('keydown',e=>__uiKeys.push({key:e.key,code:e.code,keyCode:e.keyCode,trusted:e.isTrusted,meta:e.metaKey,ctrl:e.ctrlKey,prevented:e.defaultPrevented}))`)
  // The sidebar key and actual native menu command must each toggle once.
  let sidebar=await ui.evaluate(`!!document.querySelector('.ob-sidebar')`)
  await key('\\',['meta']);await wait(`!!document.querySelector('.ob-sidebar')===${!sidebar}`);await delay(250)
  assert.equal(await ui.evaluate(`!!document.querySelector('.ob-sidebar')`),!sidebar)
  const menu=await main.evaluate(`(()=>{const v=__uiElectron.Menu.getApplicationMenu().items.find(x=>x.label==='View'),i=v.submenu.items.find(x=>x.label==='Toggle Sidebar');const value={accelerator:i.accelerator};i.click(i,__uiWindow);return value})()`)
  assert.equal(menu.accelerator,'CmdOrCtrl+\\');await wait(`!!document.querySelector('.ob-sidebar')===${sidebar}`)
  result.checks.push('sidebar-native-key-and-menu-single-toggle')
  await key('l',['meta']);assert.equal(await ui.evaluate(`document.activeElement?.id`),'ob-prompt')
  await main.evaluate(`__uiWindow.webContents.insertText('Synthetic draft retained');true`)
  await key('a',['meta']);result.standardEditing={injectedCommandASelection:await ui.evaluate(`document.activeElement.selectionEnd-document.activeElement.selectionStart`)}
  // sendInputEvent addresses Chromium, not Cocoa's performKeyEquivalent path.
  // Exercise the actual native role separately and report that boundary.
  result.standardEditing.nativeRoleDispatch=await main.evaluate(`(()=>{const edit=__uiElectron.Menu.getApplicationMenu().items.find(x=>x.label==='Edit'),item=edit.submenu.items.find(x=>x.role?.toLowerCase()==='selectall'),dispatch={windowFocused:__uiWindow.isFocused(),webContentsFocused:__uiWindow.webContents.isFocused(),clickSource:item.click.toString()};item.click(undefined,__uiWindow,__uiWindow.webContents);return dispatch})()`)
  await delay(250)
  result.standardEditing.nativeMenuSelectAllSelection=await ui.evaluate(`document.activeElement.selectionEnd-document.activeElement.selectionStart`)
  if(result.standardEditing.nativeMenuSelectAllSelection!=='Synthetic draft retained'.length){
    result.limitations=['Chromium key injection and programmatic MenuItem.click do not establish physical Cocoa accelerator dispatch. Native edit roles are installed; webContents editing is checked separately.']
    await main.evaluate(`__uiWindow.webContents.selectAll();true`)
    await wait(`document.activeElement?.selectionEnd-document.activeElement?.selectionStart===24`,2000)
    result.standardEditing.webContentsSelectAllSelection=await ui.evaluate(`document.activeElement.selectionEnd-document.activeElement.selectionStart`)
  }
  await key('k',['ctrl']);assert.equal(await ui.evaluate(`!!document.querySelector('.ob-palette-input')`),false)
  await key('f',['meta']);await wait(`document.activeElement?.classList.contains('ob-side-search-input')`)
  await key('l',['meta']);await key('k',['meta']);await wait(`!!document.querySelector('.ob-palette-input')`)
  await key('Escape');await wait(`!document.querySelector('[role=dialog]')`)
  await key(',',['meta']);await wait(`!!document.querySelector('select[aria-label="本机执行方式"]')`)
  const policy='select[aria-label="本机执行方式"]'
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(policy)}).value`),'ask-every-time')
  for(const value of ['auto-run','ask-first-time','allowlist','ask-every-time']){
    await choose(policy,value)
    await wait(`window.openbot.settings.get().then(s=>s.approvalPolicy===${JSON.stringify(value)})`)
    const s=await ui.evaluate('window.openbot.settings.get()');assert.deepEqual(s.denylist,denylist);assert.deepEqual(s.allowlist,allowlist);assert.equal(s.rules,'Synthetic local rules retained')
  }
  result.checks.push('settings-local-policy-values-persist-and-retain-restrictions')
  await shot('settings-policy');await key('Escape');await wait(`!document.querySelector('[role=dialog]')`)
  assert.equal(await ui.evaluate(`document.activeElement?.id`),'ob-prompt','Closing settings must restore composer focus')
  result.trustedKeys=await ui.evaluate(`window.__uiKeys`);assert.ok(result.trustedKeys.length>5&&result.trustedKeys.every(e=>e.trusted))
  result.nativeMenuRoles=await main.evaluate(`__uiElectron.Menu.getApplicationMenu().items.find(x=>x.label==='Edit').submenu.items.map(x=>x.role).filter(Boolean)`)
  for(const role of ['undo','redo','cut','copy','paste','selectall'])assert.ok(result.nativeMenuRoles.some(value=>value.toLowerCase()===role))
  result.checks.push('trusted-keyboard-focus-modal-and-native-edit-roles')
  // Edit actual model controls with keyboard input, preserving legacy identity.
  await click('.ob-side-item-main[aria-label="Disposable"]');await click('.ob-header-bot-trigger')
  await wait(`!!document.querySelector('#ob-bot-details')`)
  assert.equal(await ui.evaluate(`!!document.querySelector('#ob-bot-emoji')`),false)
  const model='section[aria-label="对话模型"] select[aria-label="模型"]'
  await choose(model,'fixture-lead-alternate-with-long-name')
  await choose('section[aria-label="对话模型"] select[aria-label="思考深度"]','high')
  await click('#ob-bot-details .ob-bot-editor-save .ob-btn-primary')
  await wait(`window.openbot.bots.get('disposable').then(b=>b.modelId==='fixture-lead-alternate-with-long-name'&&b.thinking==='high')`)
  let saved=await getBot('disposable');assert.equal(saved.emoji,botBase.emoji);assert.equal(saved.color,botBase.color);assert.deepEqual(saved.executionAgent,botBase.executionAgent)
  result.checks.push('real-model-controls-save-without-changing-agent-or-legacy-avatar')
  result.layouts=[]
  for(const theme of ['light','dark']){
    await ui.evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`)
    for(const width of [720,1200]){
      await main.evaluate(`__uiWindow.setSize(${width},820);true`);await delay(220)
      const layout=await ui.evaluate(`(()=>{const fields=[...document.querySelectorAll('#ob-bot-details .ob-bot-runtime-grid label')].map(l=>{const e=l.querySelector('select'),r=e.getBoundingClientRect(),p=l.getBoundingClientRect();return{label:l.textContent.trim().slice(0,30),height:p.height,selectLeft:r.left,selectRight:r.right,rowLeft:p.left,rowRight:p.right,whiteSpace:getComputedStyle(l).whiteSpace}});return{theme:document.documentElement.dataset.theme,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,fields,selectedBackground:getComputedStyle(document.querySelector('.ob-side-item.is-current')).backgroundColor}})()`)
      assert.equal(layout.overflow,false);assert.equal(layout.fields.length,6)
      for(const f of layout.fields){assert.ok(f.height<48);assert.ok(f.selectLeft>=f.rowLeft-1&&f.selectRight<=f.rowRight+1);assert.equal(f.whiteSpace,'nowrap')}
      assert.ok(['rgba(0, 0, 0, 0)','transparent'].includes(layout.selectedBackground))
      result.layouts.push(layout);await shot('details-'+theme+'-'+width)
    }
  }
  const resize=await ui.evaluate(`(()=>{const r=document.querySelector('.ob-sidebar-resize').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  await main.evaluate(`__uiWindow.webContents.sendInputEvent({type:'mouseMove',...${JSON.stringify(resize)}});__uiWindow.webContents.sendInputEvent({type:'mouseDown',...${JSON.stringify(resize)},button:'left',clickCount:1});__uiWindow.webContents.sendInputEvent({type:'mouseMove',x:100,y:${resize.y},button:'left'});__uiWindow.webContents.sendInputEvent({type:'mouseUp',x:100,y:${resize.y},button:'left',clickCount:1});true`)
  await wait(`!!document.querySelector('.ob-sidebar.is-compact')`)
  result.compact=await ui.evaluate(`(()=>{const s=document.querySelector('.ob-sidebar');return{width:s.getBoundingClientRect().width,legacyAvatars:[...s.querySelectorAll('[data-avatar-shape="legacy"]')].map(e=>e.textContent),createAvailable:!!s.querySelector('.ob-side-compact-actions button')}})()`)
  assert.ok(result.compact.width<=101);assert.ok(result.compact.legacyAvatars.includes('🧪'));assert.equal(result.compact.createAvailable,true)
  result.checks.push('actual-compact-resize-and-legacy-avatar-rendering');await shot('compact-dark-legacy')
  // A failed durable removal must keep the actual detail panel and live Bot.
  await delay(1100)
  const botFile=path.join(data,'bots','disposable.json'),savedFile=botFile+'.fixture-backup'
  await fs.rename(botFile,savedFile);await fs.mkdir(botFile)
  await deleteClick()
  await wait(`document.body.textContent.includes('Bot 删除未能完成')`)
  assert.ok(await getBot('disposable'));assert.equal(await ui.evaluate(`!!document.querySelector('#ob-bot-details .ob-bot-confirm')`),true)
  await fs.rmdir(botFile);await fs.rename(savedFile,botFile)
  await key('Escape');await wait(`!document.querySelector('.ob-bot-confirm')`)
  assert.ok(await getBot('disposable'));result.checks.push('real-delete-failure-retains-editor-and-bot')
  // Repairing an inode outside the app does not acknowledge an old failed
  // write. Persist the live Bot through its real editor before other durable
  // work; the successful write, not the fixture, clears that failure ledger.
  if(!await ui.evaluate(`!!document.querySelector('#ob-bot-details')`))await click('.ob-header-bot-trigger')
  const recoverySaveAt=Date.now();await click('#ob-bot-details .ob-bot-editor-save .ob-btn-primary')
  await wait(`window.openbot.bots.get('disposable').then(b=>b.updatedAt>=${recoverySaveAt})`)
  const savedDeadline=Date.now()+5000
  while(Date.now()<savedDeadline){const disk=JSON.parse(await fs.readFile(botFile,'utf8'));if(disk.updatedAt>=recoverySaveAt){result.failureRecovery={via:'Actual Bot editor save after synthetic storage repair',diskUpdatedAt:disk.updatedAt};break}await delay(100)}
  assert.ok(result.failureRecovery,'The recovery save must actually persist')
  // Four executor slots plus one queued task, all owned by this disposable Bot.
  const created=[]
  for(let i=0;i<5;i++)created.push(await ui.evaluate(`window.openbot.tasks.create('disposable','SYNTHETIC_HOLD_${i}','Synthetic held task ${i}')`))
  result.taskCreationReceipts=created.map(t=>t?{id:t.id,status:t.status}:null)
  await wait(`window.openbot.tasks.list().then(a=>a.filter(t=>t.botId==='disposable'&&t.status==='running').length===4&&a.filter(t=>t.botId==='disposable'&&t.status==='queued').length===1)`)
  const traceDeadline=Date.now()+30000
  while(Date.now()<traceDeadline&&(await traceRows()).filter(r=>r.method==='turn/start'&&r.model==='fixture-agent').length<4)await delay(100)
  const beforeRows=await traceRows(),beforeAgent=beforeRows.filter(r=>r.method==='turn/start'&&r.model==='fixture-agent').length
  assert.equal(beforeAgent,4)
  await deleteClick();await wait(`window.openbot.bots.get('disposable').then(b=>!b)`)
  await wait(`window.openbot.tasks.list().then(a=>${JSON.stringify(created.map(x=>x.id))}.every(id=>a.some(t=>t.id===id&&t.status==='cancelled')))`)
  await delay(450)
  assert.equal((await traceRows()).filter(r=>r.method==='turn/start'&&r.model==='fixture-agent').length,beforeAgent)
  const retained=await ui.evaluate(`window.openbot.sessions.get('disposable-home')`)
  assert.ok(retained.messages.some(m=>m.content==='SYNTHETIC_HISTORY_MUST_SURVIVE_disposable'));assert.deepEqual(retained.botIds,[])
  result.cancelledTaskIds=created.map(x=>x.id);result.checks.push('delete-cancels-running-and-queued-without-replay-and-retains-history')
  await quit();await launch()
  assert.equal(await getBot('disposable'),null);assert.ok(await getBot('keeper'))
  const settingsAfterRestart=await ui.evaluate(`window.openbot.settings.get()`)
  assert.equal(settingsAfterRestart.approvalPolicy,'ask-every-time');assert.deepEqual(settingsAfterRestart.denylist,denylist)
  assert.equal((await traceRows()).filter(r=>r.method==='turn/start'&&r.model==='fixture-agent').length,beforeAgent)
  result.checks.push('normal-restart-persists-delete-settings-and-cancelled-tasks')
  await click('.ob-side-item-main[aria-label="Keeper"]');await click('.ob-header-bot-trigger');await deleteClick()
  await wait(`window.openbot.bots.list().then(a=>a.length===0)`)
  await quit();await launch()
  assert.deepEqual(await ui.evaluate(`window.openbot.bots.list()`),[])
  assert.ok((await ui.evaluate(`window.openbot.sessions.get('keeper-home')`)).messages.some(m=>m.content==='SYNTHETIC_HISTORY_MUST_SURVIVE_keeper'))
  assert.equal((await traceRows()).filter(r=>r.method==='turn/start'&&r.model==='fixture-agent').length,beforeAgent)
  result.checks.push('last-bot-delete-remains-empty-after-restart')
  await shot('empty-roster-after-restart')
  assert.deepEqual(exceptions,[])
  await quit();result.exits=exits;assert.ok(exits.every(x=>x.code===0&&!x.signal))
  result.ok=true
} catch(error) {
  result.ok=false;result.error=String(error.stack??error)
  await shot('failure').catch(()=>{})
  result.failureUI=await ui?.evaluate(`({text:document.body.textContent.slice(-3000),active:document.activeElement?.outerHTML?.slice(0,400),keys:window.__uiKeys,selects:[...document.querySelectorAll('select')].map(e=>({label:e.getAttribute('aria-label'),value:e.value,options:[...e.options].map(o=>o.value)}))})`).catch(()=>null)
  result.failureNativeFocus=await main?.evaluate(`({windowFocused:__uiWindow.isFocused(),webContentsFocused:__uiWindow.webContents.isFocused(),focusedWindow:__uiElectron.BrowserWindow.getFocusedWindow()?.id,ownWindow:__uiWindow.id})`).catch(()=>null)
} finally {
  if(app){await quit().catch(error=>{result.cleanupError=String(error);if(app&&app.exitCode===null&&app.signalCode===null)app.kill('SIGTERM')})}
  for(const s of sockets)s.close()
  result.exits=exits
  await fs.writeFile(path.join(evidence,'electron.log'),logs)
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({ok:result.ok,root,evidence,asarSha256:asarSha,checks:result.checks,error:result.error,cleanupError:result.cleanupError}))
}
if(!result.ok)process.exitCode=1
