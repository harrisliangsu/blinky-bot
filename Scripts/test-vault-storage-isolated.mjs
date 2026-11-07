/** Real Electron + OS safeStorage, using only disposable application data. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.cwd(), root = await mkdtemp(join(tmpdir(), 'blinky-vault-electron-'))
await mkdir(join(root, 'data')); await mkdir(join(root, 'userData'))
const plan = JSON.parse(await readFile(join(repo,'docs/validation/vault-stream-patch-input.json'),'utf8'))
const eventSource = await readFile(join(repo,plan.file),'utf8')
assert.equal(eventSource,plan.candidateSource,'Actual event source must be wired; no candidate substitution is allowed.')
const eventSourceSha256 = createHash('sha256').update(eventSource).digest('hex')
await build({ stdin: { resolveDir: repo, contents: `export * from './src/main/store/vault'; export {flushAll} from './src/main/store/jsonStore'; export * as events from './src/main/agent/events'; export {liveMessages} from './src/main/agent/liveMessages'; export {streamAssistantTurn} from './src/main/agent/stream'; export {scrubVaultMessage} from './src/main/store/vaultPrivacy'; export {SessionDatabase} from './src/main/store/sessionDatabase'` }, bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: join(root, 'vault.mjs'), logLevel: 'silent', plugins: [{ name: 'no-model-discovery', setup(b) {
  b.onLoad({filter:/\/agent\/optionalModules\.ts$/},async({path})=>({contents:(await readFile(path,'utf8')).replace(/import\.meta\.glob\('[^']+'\)/g,'{}'),loader:'ts'}))
} }] })
await writeFile(join(root,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');const events=[];ipcRenderer.on('openbot:event',(_event,value)=>events.push(value));contextBridge.exposeInMainWorld('virtualVaultTest',{events:()=>events});`)
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'blinky-vault-isolated-validation', version: '1.0.0', main: 'main.cjs' }))
await writeFile(join(root, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=__dirname,stage=process.env.BLINKY_VAULT_STAGE;
const log=(name)=>{fs.appendFileSync(path.join(root,'stages.log'),stage+':'+name+'\\n');console.log(stage+':'+name)};
log('boot'); app.setName('Blinky Vault Isolated Validation');
app.setPath('userData',path.join(root,'userData'));app.setPath('sessionData',path.join(root,'sessionData'));
process.env.OPENBOT_DATA_DIR=path.join(root,'data');
app.whenReady().then(async()=>{
 log('ready');assert.equal(app.getPath('userData'),path.join(root,'userData'));assert.equal(app.getPath('sessionData'),path.join(root,'sessionData'));
 fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({electron:process.versions.electron,appName:app.getName(),userData:app.getPath('userData'),sessionData:app.getPath('sessionData')}));
 const electron=require('electron');log('before-safeStorage');
 assert.equal(electron.safeStorage.isEncryptionAvailable(),true);log('encryption-available');
 const v=await import('./vault.mjs'); const secret='virtual-only-vault-recovery-4826';
 if(stage==='write'){
  const item=await v.addVaultItem({kind:'login',label:'Virtual validation',origin:'https://fixture.invalid',values:{password:secret}});
  fs.writeFileSync(path.join(root,'item.json'),JSON.stringify({id:item.id}));log('encrypted-written');
 }else{
  const {id}=JSON.parse(fs.readFileSync(path.join(root,'item.json')));
  assert.equal((await v.listVaultItems())[0].id,id);
  assert.equal(await v.useVaultField(id,'password',async(origin,value)=>origin==='https://fixture.invalid'&&value===secret),true);log('restart-decrypted');
 }
 const ciphertext=fs.readFileSync(path.join(root,'data','vault.json'),'utf8');assert.ok(!ciphertext.includes(secret));
 assert.equal(fs.statSync(path.join(root,'data','vault.json')).mode&0o777,0o600);
 assert.ok(!Buffer.from(JSON.parse(ciphertext).items[0].ciphertext,'base64').includes(Buffer.from(secret)));
  assert.ok(!v.scrubVaultTextNow(secret).text.includes(secret));
 const filtered=v.createVaultTextStream();assert.deepEqual(filtered.push(secret.slice(0,12),'first'),[]);
 assert.equal([...filtered.push(secret.slice(12)+' safe','second'),...filtered.finish()].map(p=>p.text).join(''),'[vault value] safe');log('real-key-stream-redacted');
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(root,'preload.cjs')}});
 await window.loadURL('data:text/html,<title>Isolated vault validation</title><p id="state">virtual fixture only</p>');
 assert.equal(await window.webContents.executeJavaScript('document.querySelector("#state").textContent'),'virtual fixture only');
 log('renderer-loaded');
 const seen=[],stop=v.events.onAgentEvent(event=>seen.push(structuredClone(event)));
 const database=new v.SessionDatabase(path.join(root,'data','sessions.sqlite'));
 const start=(id)=>v.events.broadcast({type:'message-start',sessionId:id,message:{id,role:'assistant',content:'',createdAt:0,streaming:true}});
 const end=(id,content)=>v.events.broadcast({type:'message-end',sessionId:id,messageId:id,...(content===undefined?{}:{content})});
 const delta=(id,text)=>v.events.broadcast({type:'text-delta',sessionId:id,messageId:id,delta:text});
 const text=(events,id)=>events.filter(e=>e.type==='text-delta'&&e.sessionId===id).map(e=>e.delta).join('');
 const controller=new AbortController();start('virtual-main');
 const raw='ACTION '+JSON.stringify({value:secret}),call={id:'virtual-call',name:'fixture-only',arguments:JSON.stringify({value:secret,public:'keep'})};
 const result=await v.streamAssistantTurn({sessionId:'virtual-main',messageId:'virtual-main',signal:controller.signal,stream:(async function*(){
  yield {type:'text',delta:raw.slice(0,23)};yield {type:'text',delta:raw.slice(23)};
  yield {type:'reasoning',delta:secret.slice(0,12)};yield {type:'reasoning',delta:secret.slice(12)};
  yield {type:'tool_call',call};yield {type:'usage',usage:{inputTokens:10,outputTokens:5}};yield {type:'done'};
 })(),onCheckpoint:async(partial)=>{const message=v.scrubVaultMessage({id:'virtual-main',role:'assistant',createdAt:0,content:partial.text,reasoning:partial.reasoning,toolCalls:partial.calls,agentTrace:partial.agentTrace});database.put({id:'virtual-main',title:'Virtual validation',createdAt:0,updatedAt:0,messages:[message]})}});
 assert.equal(result.text,raw);assert.equal(result.calls[0].args.value,secret);assert.equal(JSON.parse(call.arguments).value,secret);
 assert.ok(!JSON.stringify(v.liveMessages('virtual-main')).includes(secret));
 const saved=v.scrubVaultMessage({id:'virtual-main',role:'assistant',createdAt:0,content:result.text,reasoning:result.reasoning,toolCalls:result.calls});
 database.put({id:'virtual-main',title:'Virtual validation',createdAt:0,updatedAt:0,messages:[saved]});
 assert.ok(!JSON.stringify(database.get('virtual-main')).includes(secret));end('virtual-main',saved.content);
 start('virtual-normal');delta('virtual-normal','Hello 🧪.');end('virtual-normal','Hello 🧪.');
 start('virtual-failure');delta('virtual-failure',secret.slice(0,12));
 fs.writeFileSync(path.join(root,'data','vault.json'),'{broken');delta('virtual-failure',secret.slice(12));
 fs.writeFileSync(path.join(root,'data','vault.json'),ciphertext,{mode:0o600});delta('virtual-failure','must stay withheld');end('virtual-failure');
 assert.equal(text(seen,'virtual-normal'),'Hello 🧪.');assert.ok(text(seen,'virtual-main').includes('[vault value]'));
 assert.equal(text(seen,'virtual-failure'),'[Content withheld: vault unavailable or changed]');assert.ok(!JSON.stringify(seen).includes(secret));
 const waitUntil=Date.now()+3000;let received=[];
 while(Date.now()<waitUntil){received=await window.webContents.executeJavaScript('window.virtualVaultTest.events()');if(received.length===seen.length)break;await new Promise(r=>setTimeout(r,20))}
 assert.deepEqual(received,seen);assert.ok(!JSON.stringify(received).includes(secret));
 assert.equal(received.find(e=>e.type==='tool-call').call.args.value,'[vault value]');
 assert.deepEqual(v.liveMessages('virtual-main'),[]);assert.deepEqual(v.liveMessages('virtual-failure'),[]);
 fs.writeFileSync(path.join(root,stage+'-events-result.json'),JSON.stringify({passed:true,actualIpc:true,actualEventSource:true,listenerEvents:seen.length,rendererEvents:received.length,actualSafeStorage:true,failClosed:true,executionParametersUnchanged:true,normalStreamUnchanged:true}));
 database.close();stop();log('actual-event-ipc-passed');window.destroy();await v.flushAll();log('passed');app.exit(0);
}).catch(()=>{log('failed');app.exit(1)});
`)
const electron = join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const results = []
for (const stage of ['write', 'recover']) {
  const env = { ...process.env, BLINKY_VAULT_STAGE: stage }
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','OPENBOT_DATA_DIR','BLINKY_SMOKE','BLINKY_SMOKE_DIR','BLINKY_NATIVE_RUNTIME']) delete env[key]
  const child = spawn(electron, [root], { env, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data; process.stdout.write(data) })
  child.stderr.on('data', () => {}) // native diagnostics may describe unrelated local environment
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20000)
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timer); results.push({ stage, exitCode, timedOut })
  await writeFile(join(root, 'result.json'), JSON.stringify({ root, electron, results, runtime: JSON.parse(await readFile(join(root,'runtime.json'),'utf8')), eventSourceSha256, sharedEventSourceApplied:true, source: 'actual vault/events/stream/normalizer/IPC/liveMessages/SQLite; no storage or transport override; unused optional backend/tool discovery globs empty', formalAppUntouched: true }, null, 2))
  if (timedOut || exitCode !== 0) { console.log(JSON.stringify({ root, results })); process.exitCode = 1; break }
  assert.ok(output.includes(stage + ':passed'))
}
console.log(JSON.stringify({ root, results, stages: await readFile(join(root, 'stages.log'),'utf8') }))
