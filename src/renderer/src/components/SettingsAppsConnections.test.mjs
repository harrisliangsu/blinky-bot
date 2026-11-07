// Suspended Electron UI fixture with a mock IPC boundary.
import { test } from 'node:test'

// show:false and app.dock.hide() cannot suppress native macOS crash dialogs.
// Keep this fixture for a separate CI/VM session; never launch it locally.
test('application connection UI in Electron', { skip: 'Suspended: native Electron may show desktop dialogs; requires an isolated CI/VM session.' }, async () => {
const { build } = await import('esbuild')
const { mkdtemp, writeFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os'), { default: path } = await import('node:path')
const { spawnSync } = await import('node:child_process')
const { connectionTestEnvironment } = await import('../../../main/connectors/testEnvironment.mjs')
const repo = process.cwd(), root = await mkdtemp(path.join(tmpdir(), 'blinky-connections-ui-'))
await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SettingsApps} from './src/renderer/src/components/SettingsApps';
import {store} from './src/renderer/src/state';
import './src/renderer/src/tokens.css'; import './src/renderer/src/controls.css';
store.patch({settings:{language:'zh-CN'},bots:[{id:'fixture-bot',name:'Fixture Bot'}]} as any);
const calls:any[]=[]; let pending:any; let slackView:any={state:'disconnected',browserReady:true};
let rows:any[]=[{id:'github',status:'connected',account:'fixture'}, {id:'git',status:'disconnected'}, {id:'gmail',status:'disconnected',detail:'oauth-client-required'}, {id:'calendar',status:'disconnected',detail:'oauth-ready'}, {id:'slack',status:'disconnected'}, {id:'x',status:'disconnected',detail:'oauth-ready'}];
(window as any).calls=calls;
const disconnected=(id:string) => {rows=rows.map(r=>r.id===id?{id,status:'disconnected',detail:'oauth-ready'}:r); calls.push(['disconnect',id]);return Promise.resolve({ok:true})};
const connect=(id:string,...args:any[])=>{calls.push(['connect',id,...args]);return new Promise(resolve=>{pending={id,resolve};})};
(window as any).finish=(ok:boolean)=>{if(ok && pending.id==='slack') slackView={state:'connected',mode:'browser',browserReady:true,teamId:'T123',channelId:'C123',allowedUserId:'U123',botId:'fixture-bot'};if(ok) rows=rows.map(r=>r.id===pending.id?{id:r.id,status:'connected',account:'fixture@example.test'}:r);pending.resolve({ok});pending=null;};
(window as any).openbot={apps:{status:()=>Promise.resolve(rows),slackStatus:()=>Promise.resolve(slackView),connectSlack:(input:any)=>connect('slack',input),disconnectSlack:()=>{slackView={state:'disconnected',browserReady:true};return disconnected('slack')},connectGoogle:connect,connectX:(id:string)=>connect('x',id),cancelGoogle:()=>{calls.push(['cancel','google']);if(pending&&pending.id!=='x') (window as any).finish(false);return Promise.resolve()},cancelX:()=>{calls.push(['cancel','x']);if(pending?.id==='x') (window as any).finish(false);return Promise.resolve()},disconnectGoogle:disconnected,disconnectX:()=>disconnected('x'),disconnectGitHub:()=>disconnected('github')}};
createRoot(document.getElementById('app')!).render(<SettingsApps/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(root, 'app.js'), logLevel: 'silent' })
await writeFile(path.join(root, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>body{margin:0;padding:24px;background:var(--ob-bg-editor);color:var(--ob-text-primary);font-family:-apple-system,sans-serif}button,input{font:inherit}.ob-hint{font-size:12px;color:var(--ob-text-secondary);line-height:1.5}</style><div id="app"></div><script src="app.js"></script>')
await writeFile(path.join(root, 'runner.cjs'), `
let app;const fail=e=>{console.error(e);if(app)app.exit(1);else process.exit(1)};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const electron=require('electron');app=electron.app;const {BrowserWindow,nativeTheme}=electron;const fs=require('fs');const path=require('path');
const root=process.argv[2];app.setPath('userData',path.join(root,'profile'));if(process.platform==='darwin')app.dock.hide();
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false}});try{
win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,callback)=>callback({cancel:true}));
await win.loadFile(path.join(root,'index.html'));
const result=await win.webContents.executeJavaScript(\`(async()=>{
const wait=()=>new Promise(r=>setTimeout(r,90));const assert=(x,m)=>{if(!x)throw Error(m)};const card=id=>document.querySelector('[data-app="'+id+'"]');const button=(id,text)=>[...card(id).querySelectorAll('button')].find(b=>b.textContent===text);
await wait();assert(card('gmail').textContent.includes('尚未由发行方启用'),'missing setup not visible');
assert(button('gmail','浏览器登录暂不可用').disabled,'missing distributor client must not enter a setup flow');button('gmail','高级：自带客户端').click();await wait();assert(card('gmail').querySelector('input[type=file]'),'desktop JSON import missing');assert(window.calls.length===0,'missing client opened OAuth');
const fileInput=card('gmail').querySelector('input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify({installed:{client_id:'123456789-fixture.apps.googleusercontent.com',client_secret:'fixture-desktop-secret'}})],'desktop.json',{type:'application/json'}));fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}));await wait();assert(card('gmail').querySelector('[aria-label="Google OAuth client ID"]').value==='123456789-fixture.apps.googleusercontent.com','desktop JSON did not populate client');assert(card('gmail').querySelector('input[type=password]').value==='fixture-desktop-secret','desktop secret import failed');
window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait();assert(!card('gmail').querySelector('input[type=file]'),'Escape did not close setup');
button('calendar','浏览器登录').click();await wait();assert(JSON.stringify(window.calls.at(-1))===JSON.stringify(['connect','calendar','','',undefined]),'calendar required renderer client fields');assert(!card('calendar').querySelector('input'),'one click login exposed config fields');button('calendar','取消授权').click();await wait();assert(card('calendar').querySelector('[role=alert]'),'cancel/error is hidden');
button('calendar','浏览器登录').click();await wait();window.finish(true);await wait();assert(card('calendar').textContent.includes('已连接'),'success status not refreshed');button('calendar','重新授权').click();await wait();assert(JSON.stringify(window.calls.at(-1))===JSON.stringify(['connect','calendar','','',undefined]),'reconnect required key');window.finish(true);await wait();
button('calendar','断开').click();await wait();assert(card('calendar').textContent.includes('不会撤销'),'local disconnect scope hidden');button('calendar','确认断开').click();await wait();assert(card('calendar').textContent.includes('未连接'),'disconnect did not refresh');
button('x','浏览器登录').click();await wait();assert(JSON.stringify(window.calls.at(-1))===JSON.stringify(['connect','x','']),'X required renderer client fields');window.finish(false);await wait();assert(card('x').querySelector('[role=alert]'),'X error not visible');
button('github','断开').click();await wait();assert(window.calls.some(x=>x[0]==='disconnect'&&x[1]==='github'),'GitHub disconnect IPC missing');assert(card('github').textContent.includes('未连接'),'GitHub disconnected state missing');
button('slack','连接').click();await wait();assert(!card('slack').querySelector('input[type=password]'),'browser mode asks for tokens');
const channel=card('slack').querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(channel,'https://app.slack.com/client/T123/C123');channel.dispatchEvent(new Event('input',{bubbles:true}));await wait();
assert(!button('slack','在浏览器中授权').disabled,'valid browser channel cannot authorize');button('slack','在浏览器中授权').click();await wait();const slackCall=window.calls.at(-1);assert(slackCall[1]==='slack'&&slackCall[2].appToken===''&&slackCall[2].botToken===''&&slackCall[2].allowedUserId===''&&slackCall[2].channelId==='C123','Slack browser request contains manual tokens or wrong target');window.finish(true);await wait();assert(card('slack').textContent.includes('不接收频道消息'),'browser capability boundary hidden');button('slack','断开').click();await wait();button('slack','确认断开').click();await wait();assert(card('slack').textContent.includes('未连接'),'Slack disconnect did not refresh');button('slack','连接').click();await wait();
return {assertions:'passed',overflow:document.documentElement.scrollWidth>window.innerWidth,calls:window.calls};})()\`,true);
console.log(JSON.stringify(result));for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));for(const width of [1080,520]){win.setSize(width,1000);await new Promise(r=>setTimeout(r,120));await win.webContents.executeJavaScript("document.querySelector('[data-app=slack]').scrollIntoView({block:'start'})");const page=await win.capturePage();fs.writeFileSync(path.join(root,theme+'-'+width+'.png'),page.toPNG());const overflow=await win.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth');if(overflow)throw Error('horizontal overflow at '+theme+' '+width);const overlap=await win.webContents.executeJavaScript("(()=>{const rects=[...document.querySelectorAll('button')].map(b=>b.getBoundingClientRect()).filter(r=>r.width&&r.height);return rects.some((a,i)=>rects.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1))})()");if(overlap)throw Error('overlapping buttons at '+theme+' '+width)}}
console.log('Screenshots: '+root);win.destroy();app.quit();}catch(e){console.error(e);win.destroy();app.exit(1)}}).catch(fail)
`)
const child = spawnSync(path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [path.join(root, 'runner.cjs'), root], { encoding: 'utf8', timeout: 30_000, env: await connectionTestEnvironment(root) })
process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '')
if (child.error) throw child.error
if (child.status !== 0) throw new Error(`UI test failed: ${child.status} ${child.signal}`)
console.log('Isolated UI artifacts retained:', root)
})
