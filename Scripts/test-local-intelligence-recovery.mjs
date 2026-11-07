/** Hidden Electron: real feature UI + preload + trusted IPC + stores. No accounts or network. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(), root=await mkdtemp(join(tmpdir(),'blinky-intelligence-app-')), data=join(root,'data')
await mkdir(data)
const virtualNotificationPatch=process.env.INTEL_TEST_NOTIFICATION_PATCH==='1'
const evidence=resolve('docs/test-evidence/intelligence-recovery-20261106',virtualNotificationPatch?'with-notification-filter':'.')
await mkdir(evidence,{recursive:true})
const abs=p=>JSON.stringify(join(repo,p))
const mocks={
 '../ipc/agentRuntime': `export const AGENT_UNAVAILABLE='Fixture unavailable';export const loopFn=async name=>name==='sendMessage'?globalThis.__fixtureSend:null`,
 '../agent/messageQueueRuntime': `export const isQueueDraining=()=>false;export const isQueueSuspended=()=>false`,
 './backendGateway': `export const getBackendInfo=async()=>null;export const runSideCall=async()=>{throw Error('External model calls are prohibited in this fixture')}`,
 '../app/routineLauncher': `export const getRoutineLauncherStatus=()=>({state:'unavailable'})`,
 '../routines/webhookSecrets': `export const getOrCreateWebhookSecret=async()=>{throw Error('No credentials in this test')}`,
 '../routines/webhookServer': `export const syncWebhookListener=()=>{};export const webhookStatus=()=> 'inactive';export const webhookPort=()=>0`,
 '../connectors/githubWatch': `export const githubIssueFingerprint=async()=>{throw Error('No external services in this test')}`,
 '../connectors/gmailWatch': `export const gmailQueryFingerprint=async()=>{throw Error('No external services in this test')}`
}
mocks['./agentRuntime']=mocks['../ipc/agentRuntime']
const main=`
import {app,BrowserWindow,ipcMain} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {initSettings,getSettings} from ${abs('src/main/settings.ts')};
import {loadBots,createBot,listBots} from ${abs('src/main/store/bots.ts')};
import {loadSessions,getSession,saveSession} from ${abs('src/main/store/sessions.ts')};
import {ensureBotHome} from ${abs('src/main/store/botHome.ts')};
import {loadMemory,listBotMemory,writeUserMemory} from ${abs('src/main/store/memory.ts')};
import {loadRoutines,createRoutineDurable,getRoutine} from ${abs('src/main/store/routines.ts')};
import {loadTasks} from ${abs('src/main/store/tasks.ts')};
import {loadActivity,listActivity} from ${abs('src/main/store/activity.ts')};
import {saveUserMemory,deleteUserMemory} from ${abs('src/main/ipc/memory.ts')};
import {registerRoutineIpc} from ${abs('src/main/ipc/routines.ts')};
import {handle,handleEvent} from ${abs('src/main/ipc/handler.ts')};
import {tickRoutineScheduler} from ${abs('src/main/routines/scheduler.ts')};
import {listRoutineRuns} from ${abs('src/main/routines/runs.ts')};
import {rememberFact} from ${abs('src/main/agent/memory.ts')};
import {broadcast} from ${abs('src/main/agent/events.ts')};
import {flushAll} from ${abs('src/main/store/jsonStore.ts')};
app.setPath('userData',process.env.OPENBOT_DATA_DIR);await app.whenReady();app.dock?.hide();
await initSettings();await loadMemory();await loadSessions();await loadBots();await loadTasks();await loadRoutines();await loadActivity();
const setupFile=join(process.env.OPENBOT_DATA_DIR,'fixture.json');let setup;
try{setup=JSON.parse(await readFile(setupFile,'utf8'))}catch{
 const a=createBot({name:'Fixture A',backendId:'codex',modelId:'fixture',followsDefault:false,tools:[],executionAgentDisabled:true});
 const b=createBot({name:'Fixture B',backendId:'codex',modelId:'fixture',followsDefault:false,tools:[],executionAgentDisabled:true});
 const home=ensureBotHome(a.id);saveSession({...home,mode:'agent',cwd:process.env.OPENBOT_DATA_DIR});
 const memory=await writeUserMemory(a.id,'用户习惯使用蓝色杯子喝无糖花茶。',undefined,'seed');
 const routine=await createRoutineDurable({botId:a.id,name:'本地例程',instruction:'initial result',notifyPolicy:'quiet',trigger:{kind:'manual'}});
 const webhookRoutine=await createRoutineDurable({botId:b.id,name:'Webhook 本地信号',instruction:'Local fixture only.',trigger:{kind:'webhook'}});
 setup={a:a.id,b:b.id,home:home.id,memory:memory.id,routine:routine.id,webhookRoutine:webhookRoutine.id};await writeFile(setupFile,JSON.stringify(setup));
}
globalThis.__fixtureSend=async(id,text)=>{
 if(text.includes('crash boundary'))await new Promise(r=>setTimeout(r,30000));else await new Promise(r=>setTimeout(r,120));
 let result=getRoutine(setup.routine)?.instruction??'result';
 if(text.includes('auto old fact'))result=(await rememberFact(setup.a,'用户习惯使用蓝色杯子喝无糖花茶。','run')).reason;
 const s=getSession(id);saveSession({...s,messages:[...s.messages,{id:crypto.randomUUID(),role:'assistant',content:result,createdAt:Date.now()}]});
 broadcast({type:'done',sessionId:id});
};
handle('openbot:bots:list',()=>listBots().filter(b=>[setup.a,setup.b].includes(b.id)).sort((a,b)=>a.name.localeCompare(b.name)),()=>[]);
handle('openbot:bots:memory',([id])=>listBotMemory(id),()=>[]);
handleEvent('openbot:bots:addMemory',(_e,[id,input])=>saveUserMemory(id,input),()=>null);
handleEvent('openbot:bots:removeMemory',(_e,[id,entry])=>deleteUserMemory(id,entry),()=>false);
handle('openbot:settings:get',()=>getSettings(),()=>null);
handle('openbot:activity:list',()=>listActivity(),()=>[]);
handle('openbot:sessions:get',([id])=>getSession(id),()=>null);
registerRoutineIpc();await tickRoutineScheduler();await flushAll();
const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{preload:${JSON.stringify(join(root,'preload.cjs'))},contextIsolation:true,sandbox:true,nodeIntegration:false}});
win.webContents.on('did-finish-load',()=>{});await win.loadFile(${JSON.stringify(join(root,'index.html'))});
await writeFile(${JSON.stringify(join(root,'ready.json'))},JSON.stringify({...setup,pid:process.pid}));
setInterval(async()=>{await writeFile(${JSON.stringify(join(root,'observed.json'))},JSON.stringify({runs:await listRoutineRuns(setup.routine),activity:listActivity()}))},250).unref();
app.on('window-all-closed',()=>app.quit());
`
await writeFile(join(data,'settings.json'),JSON.stringify({language:'zh-CN',theme:'light',memoryExtraction:'off',notifications:false,notifyOnTurn:true,defaultMode:'agent',backends:{codex:{enabled:false},grok:{enabled:false},kimi:{enabled:false}}}))
await build({stdin:{contents:main,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'esm',external:['electron'],outfile:join(root,'main.mjs'),plugins:[{name:'isolated-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));if(virtualNotificationPatch)b.onLoad({filter:/\/ipc\/broadcast\.ts$/},async a=>{let source=await readFile(a.path,'utf8');if(!source.includes('routineOwnsNotifications'))source=`import {routineOwnsNotifications} from '../routines/notifications'\n`+source.replace("  if (event.type === 'activity-updated' || event.type === 'task-updated') return","  if (event.type === 'activity-updated' || event.type === 'task-updated') return\n  if ((event.type === 'done' || event.type === 'error') && routineOwnsNotifications(event.sessionId)) return");return {contents:source,loader:'ts'}})}}]})
await build({entryPoints:[resolve('src/preload/index.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(root,'preload.cjs')})
const ui=`import ${abs('src/renderer/src/styles.css')};import ${abs('src/renderer/src/controls.css')};import ${abs('src/renderer/src/feedback.css')};import React from 'react';import{createRoot}from'react-dom/client';import{BotMemory}from ${abs('src/renderer/src/components/BotMemory.tsx')};import{RoutinePanel}from ${abs('src/renderer/src/components/RoutinePanel.tsx')};import{store}from ${abs('src/renderer/src/state/core.ts')};
const root=createRoot(document.getElementById('root'));const bots=await window.openbot.bots.list();const settings=await window.openbot.settings.get();store.patch({bots,settings,currentSessionId:bots[0].activeConversationId,modal:'routines'});
window.fixture={bots,getModal:()=>store.getState().modal,showMemory(id=bots[0].id){root.render(React.createElement(BotMemory,{botId:id}))},showRoutines(){store.patch({modal:'routines'});root.render(React.createElement(RoutinePanel))},showWebhook(){store.patch({bots:[bots[1],bots[0]],modal:'routines'});root.render(React.createElement(RoutinePanel,{key:'webhook-fixture'}))}};window.fixture.showMemory();`
await build({stdin:{contents:ui,resolveDir:repo,loader:'tsx'},bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:join(root,'ui.js'),loader:{'.woff2':'dataurl','.svg':'dataurl'}})
await writeFile(join(root,'index.html'),'<html data-theme="light"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script type="module" src="ui.js"></script></body></html>')
await writeFile(join(root,'bootstrap.cjs'),`import('./main.mjs').catch(e=>{console.error('Fixture startup failed',e);process.exit(1)})`)
const electron=resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let app,ws,port=19300+Math.floor(Math.random()*1000),seq=0,pending=new Map(),logs=''
async function launch(){
 app=spawn(electron,[join(root,'bootstrap.cjs'),`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{env:{...process.env,OPENBOT_DATA_DIR:data,BLINKY_SMOKE:'1'},stdio:['ignore','pipe','pipe']});app.stderr.on('data',b=>logs+=b);app.stdout.on('data',b=>logs+=b)
 app.on('error',e=>logs+=`\nspawn error: ${e.message}`);app.on('exit',(code,signal)=>logs+=`\nchild exit: ${code}/${signal}`)
 let target;for(let i=0;i<150;i++){try{const ts=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();target=ts.find(t=>t.type==='page');if(target)break}catch{}await delay(100)}
 if(!target)throw Error('No isolated renderer: '+logs.slice(-4500))
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 await wait(`!!window.fixture`)
}
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function ev(expression){const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression){for(let i=0;i<200;i++){if(await ev(`Promise.resolve(${expression}).then(Boolean)`))return;await delay(50)}throw Error('UI timeout: '+expression+' '+logs.slice(-2500))}
const input=(selector,text)=>`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
async function click(text){await ev(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Button missing');e.click()})()`)}
let result
try{
 await launch();await wait(`document.body.innerText.includes('蓝色杯子')`)
 await ev(`document.querySelector('[aria-label^="更正记忆"]').click()`)
 await ev(input('.ob-memory-add input','用户习惯使用白色杯子喝无糖花茶。'));await ev(`document.querySelector('[aria-label="保存更正"]').click()`)
 await wait(`document.body.innerText.includes('白色杯子')&&!document.querySelector('[aria-label="保存更正"]')`)
 await ev(`document.querySelector('[aria-label="移除此记忆"]').click()`);await wait(`document.body.innerText.includes('还没有保存记忆')`)
 const setup=JSON.parse(await readFile(join(data,'fixture.json'),'utf8'))
 const forged=await ev(`window.openbot.routines.update(${JSON.stringify(setup.routine)},{lastRunState:'finished',runs:[{status:'finished'}]})`)
 assert.equal(forged.lastRunState,undefined);assert.equal(forged.runs.length,0)
 await ev(`window.fixture.showRoutines()`);await wait(`document.body.innerText.includes('本地例程')&&document.body.innerText.includes('运行记录')`)
 await ev(`(()=>{const s=document.querySelector('select[id^="routine-notify-"]');s.value='on_change';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
 await wait(`window.openbot.routines.get(${JSON.stringify(setup.routine)}).then(r=>r.notifyPolicy==='on_change')`)
 await ev(`(()=>{const s=document.querySelector('select[id^="routine-notify-"]');s.value='quiet';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
 await wait(`window.openbot.routines.get(${JSON.stringify(setup.routine)}).then(r=>r.notifyPolicy==='quiet')`)
 await ev(`window.openbot.routines.update(${JSON.stringify(setup.routine)},{instruction:'auto old fact',notifyPolicy:'quiet'})`)
 await click('运行');await wait(`document.querySelector('[data-run-status="finished"]')`)
 await wait(`document.body.innerText.includes('查看结果')`)
 await wait(`window.openbot.routines.get(${JSON.stringify(setup.routine)}).then(r=>r.runs?.[0]?.notificationState==='quiet')`)
 const observed=await ev(`Promise.all([window.openbot.routines.get(${JSON.stringify(setup.routine)}),window.openbot.activity.list()]).then(([r,activity])=>({runs:r.runs,activity}))`)
 assert.equal(observed.runs[0].result,'forgotten by user')
 assert.equal(observed.runs[0].notificationState,'quiet')
 const genericQuietLeak=observed.activity.some(a=>a.detail.includes('finished while BlinkyBot'))
 assert.equal(genericQuietLeak,false)
 await cmd('Emulation.setDeviceMetricsOverride',{width:740,height:850,deviceScaleFactor:1,mobile:false})
 await ev(`document.documentElement.dataset.theme='light'`);await delay(100)
 await writeFile(join(evidence,'routine-light.png'),Buffer.from((await cmd('Page.captureScreenshot',{format:'png'})).data,'base64'))
 await cmd('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false})
 await ev(`document.documentElement.dataset.theme='dark'`);await delay(100)
 await writeFile(join(evidence,'routine-dark.png'),Buffer.from((await cmd('Page.captureScreenshot',{format:'png'})).data,'base64'))
 // A real process death during a started occurrence, followed by a fresh Main,
 // exercises persistence and recovery rather than resetting a module cache.
 await ev(`window.openbot.routines.update(${JSON.stringify(setup.routine)},{instruction:'crash boundary'})`)
 await click('运行');await wait(`document.querySelector('[data-run-status="running"]')`)
 ws.close();app.kill('SIGKILL');await new Promise(r=>app.once('exit',r));port++
 await launch();await wait(`document.body.innerText.includes('还没有保存记忆')`)
 await ev(`window.fixture.showRoutines()`);await wait(`document.querySelector('[data-run-status="unknown"]')`)
 const after=await ev(`window.openbot.routines.get(${JSON.stringify(setup.routine)}).then(r=>({runs:r.runs}))`)
 assert.equal(after.runs.filter(r=>r.status==='unknown').length,1)
 assert.equal(after.runs.length,2)
 await ev(`window.fixture.showMemory()`);await wait(`document.querySelector('.ob-memory-add input')`)
 await ev(input('.ob-memory-add input','用户习惯使用蓝色杯子喝无糖花茶。'));await ev(`document.querySelector('.ob-memory-add input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
 await wait(`document.body.innerText.includes('蓝色杯子')`)
 await ev(`document.querySelector('[aria-label="所有 Bot 共享"]').click()`)
 await ev(input('.ob-memory-add input','所有 Bot 默认使用中文书写简洁的项目说明。'));await ev(`document.querySelector('[aria-label="添加记忆"]').click()`)
 await wait(`document.body.innerText.includes('简洁的项目说明')`)
 await ev(`window.fixture.showMemory(${JSON.stringify(setup.b)})`);await wait(`document.body.innerText.includes('简洁的项目说明')`)
 await ev(`document.querySelector('[aria-label="从所有 Bot 中移除此偏好"]').click()`);await wait(`document.body.innerText.includes('还没有保存记忆')`)
 await ev(`window.fixture.showMemory(${JSON.stringify(setup.a)})`);await wait(`document.body.innerText.includes('蓝色杯子')&&!document.body.innerText.includes('简洁的项目说明')`)
 await ev(`window.fixture.showWebhook()`);await wait(`document.body.innerText.includes('Webhook 本地信号')&&document.querySelector('select[id^="routine-notify-"]')`)
 assert.equal(await ev(`document.querySelector('select[id^="routine-notify-"]').disabled`),false)
 assert.equal((await ev(`window.openbot.routines.get(${JSON.stringify(setup.webhookRoutine)})`)).runs.length,0)
 result={root,realElectron:true,hiddenWindow:true,actualMemoryEditDelete:true,sharedMemoryAcrossBots:true,restartAfterSigkill:true,committedDeletionRetained:true,automaticOldFactRefused:true,freshExplicitRestore:true,routineHistory:true,forgedCompletionRefused:true,unknownWithoutReplay:true,lightNarrow:true,darkWide:true,webhookPolicyEnabled:true,genericQuietLeak,virtualNotificationPatch,externalServicesUsed:false,realProviderCli:false}
 await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{ws?.close();if(app&&app.exitCode===null){app.kill('SIGTERM');await delay(300);if(app.exitCode===null)app.kill('SIGKILL')}await writeFile(join(evidence,'electron.log'),logs)}
