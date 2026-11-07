/** Real Electron/OS crypto/registered tool; browser adapter points only to a local fake page. */
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
const repo=process.cwd(),root=await mkdtemp(join(tmpdir(),'blinky-vault-reference-'))
await mkdir(join(root,'data'))
await build({stdin:{resolveDir:repo,contents:`export * as vault from './src/main/store/vault';export {runTool,schemasFor} from './src/main/tools/registry';export {vaultFillExpression} from './src/main/tools/computer/browser/vaultFill';export {flushAll} from './src/main/store/jsonStore'`},bundle:true,platform:'node',format:'esm',external:['electron'],outfile:join(root,'module.mjs'),logLevel:'silent',plugins:[{name:'local-page-provider',setup(b){
 b.onResolve({filter:/^\.\/index$/},({importer})=>importer.endsWith('/computer/gate.ts')?{path:'provider',namespace:'fixture'}:undefined)
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const LOCAL_TARGET={kind:'local'};export const describeTarget=()=> 'isolated virtual browser';export const getComputerProvider=()=>globalThis.__virtualVaultProvider`,loader:'js'}))
 b.onLoad({filter:/\/agent\/optionalModules\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replace(/import\.meta\.glob\('[^']+'\)/g,'{}'),loader:'ts'}))
}}]})
await build({stdin:{resolveDir:repo,contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SettingsVault}from'./src/renderer/src/components/SettingsVault';import './src/renderer/src/tokens.css';import './src/renderer/src/controls.css';createRoot(document.getElementById('root')).render(React.createElement(SettingsVault,{zh:true}));`},bundle:true,platform:'browser',format:'iife',outfile:join(root,'ui.js'),logLevel:'silent'})
await writeFile(join(root,'ui.html'),'<link rel="stylesheet" href="ui.css"><style>body{margin:0;padding:20px;box-sizing:border-box;font-family:-apple-system;background:var(--ob-bg);color:var(--ob-text)}</style><div id="root"></div><script src="ui.js"></script>')
await writeFile(join(root,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('openbot',{vault:{list:()=>ipcRenderer.invoke('virtual:vault-list')}})`)
await writeFile(join(root,'package.json'),JSON.stringify({name:'blinky-vault-isolated-validation',version:'1.0.0',main:'main.cjs'}))
await writeFile(join(root,'main.cjs'),`
const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('assert/strict'),fs=require('fs'),path=require('path'),http=require('http');
const root=__dirname;app.setName('Blinky Vault Isolated Validation');app.setPath('userData',path.join(root,'userData'));app.setPath('sessionData',path.join(root,'sessionData'));process.env.OPENBOT_DATA_DIR=path.join(root,'data');
const log=x=>console.log(x);
app.whenReady().then(async()=>{
 log('ready');const api=await import('./module.mjs'),secret='virtual-reference-only-4826';
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<input id="password" type="password" autocomplete="current-password"><button id="submit">Submit</button><script>window.submits=0;submit.onclick=()=>window.submits++</script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,origin='http://127.0.0.1:'+port;
 const item=await api.vault.addVaultItem({kind:'login',label:'Virtual login',origin,values:{password:secret}}),ref=api.vault.vaultItemRef(item.id);
 ipcMain.handle('virtual:vault-list',async()=>({ok:true,value:await api.vault.listVaultItems()}));
 const ui=new BrowserWindow({show:false,useContentSize:true,width:1080,height:800,webPreferences:{preload:path.join(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});await ui.loadFile(path.join(root,'ui.html'));
 for(let i=0;i<100;i++){if(await ui.webContents.executeJavaScript('!!document.querySelector(".ob-vault-item code")'))break;await new Promise(r=>setTimeout(r,20))}
 log('checking-reference-component');assert.equal(await ui.webContents.executeJavaScript('document.querySelector(".ob-vault-item code").textContent'),ref);
 for(const theme of ['light','dark'])for(const width of [1080,520]){ui.setContentSize(width,800);await ui.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));await new Promise(r=>setTimeout(r,50));const layout=await ui.webContents.executeJavaScript('({width:innerWidth,scale:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1,text:document.body.innerText})');assert.equal(layout.width,width);assert.equal(layout.overflow,false);assert.ok(!layout.text.includes(secret));let image=await ui.webContents.capturePage();if(image.isEmpty()){ui.showInactive();await new Promise(r=>setTimeout(r,50));image=await ui.webContents.capturePage()}log(JSON.stringify({theme,width,scale:layout.scale,pngWidth:image.getSize().width}));assert.equal(image.getSize().width,Math.round(width*layout.scale));fs.writeFileSync(path.join(root,'vault-'+theme+'-'+width+'.png'),image.toPNG())}log('reference-ui-passed');
 const page=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await page.loadURL(origin);await page.webContents.executeJavaScript('document.querySelector("#password").focus()');let fills=0,screens=0,approved=true;const approvals=[],emitted=[];
 globalThis.__virtualVaultProvider={activeApp:async()=>new URL(page.webContents.getURL()).hostname,screenshot:async()=>{screens++;throw Error('Vault must not capture form images')},fillVaultField:async(site,field,value)=>{fills++;return page.webContents.executeJavaScript(api.vaultFillExpression(site,field,value))}};
 const ctx={sessionId:'virtual-session',botId:'virtual-bot',cwd:root,dataDir:path.join(root,'data'),computerTarget:{kind:'browser',botId:'virtual-bot',provider:'ego'},signal:new AbortController().signal,settings:{computerUseAllowedApps:['127.0.0.1','localhost']},emit:e=>emitted.push(e),requestApproval:async request=>{approvals.push(request);return approved}};
 assert.ok(api.schemasFor(['type_text'],ctx.computerTarget)[0].parameters.properties.vault_field);
 const call={id:'virtual-call',name:'type_text',args:{text:ref,vault_field:'password'}};
 approved=false;assert.equal((await api.runTool(call,ctx)).ok,false);assert.equal(fills,0);
 approved=true;const result=await api.runTool(call,ctx);assert.equal(result.ok,true);assert.equal(await page.webContents.executeJavaScript('document.querySelector("#password").value'),secret);assert.equal(await page.webContents.executeJavaScript('window.submits'),0);assert.equal(screens,0);assert.deepEqual(emitted,[]);assert.ok(!JSON.stringify({result,approvals,call}).includes(secret));
 await page.loadURL(origin+'/other');await page.webContents.executeJavaScript('document.querySelector("#password").autocomplete="email";document.querySelector("#password").focus()');assert.equal((await api.runTool(call,ctx)).ok,false);
 // Same hostname with another port is refused inside the single DOM operation.
 await page.webContents.executeJavaScript('document.querySelector("#password").autocomplete="current-password"');globalThis.__virtualVaultProvider.fillVaultField=async(site,field,value)=>page.webContents.executeJavaScript(api.vaultFillExpression(site.replace(':'+port,':'+(port+1)),field,value));assert.equal((await api.runTool(call,ctx)).ok,false);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,electron:process.versions.electron,realSafeStorage:true,realRegistry:true,realApprovalFunction:true,browserProvider:'isolated local-page adapter; not Ego profile isolation',realDomExpression:true,referenceVisibleInRealComponent:true,themes:['light','dark'],widths:[1080,520],approvalDeniedBeforeFill:true,focusedFieldAndOriginEnforced:true,noSubmit:true,noScreenshot:true,noValueInResults:true},null,2));
 log('registered-reference-tool-passed');await api.flushAll();ui.destroy();page.destroy();await new Promise(r=>server.close(r));app.exit(0);
}).catch(error=>{console.log(JSON.stringify({failure:error.name,location:String(error.stack).split('\\n').find(line=>/^ +at /.test(line))}));app.exit(1)});
`)
const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','OPENBOT_DATA_DIR','BLINKY_NATIVE_RUNTIME','BLINKY_SMOKE','BLINKY_SMOKE_DIR'])delete env[key]
const child=spawn(join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[root],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>process.stdout.write(x));child.stderr.on('data',()=>{});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},20000);const code=await new Promise((r,j)=>{child.on('exit',r);child.on('error',j)});clearTimeout(timer);console.log(JSON.stringify({root,code,timedOut}));if(code!==0||timedOut)process.exitCode=1;
