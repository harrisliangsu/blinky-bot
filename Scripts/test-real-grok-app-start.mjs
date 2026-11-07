/** Isolated Electron + real Grok: verify the app's policy probe before a turn. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.env.BLINKY_TEST_GROK_BIN) throw new Error('Set BLINKY_TEST_GROK_BIN for this explicit live CLI test.');
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-real-grok-app-')),data=path.join(root,'data'),wrapper=path.join(root,'grok'),marker=path.join(root,'marker-path')
await fs.mkdir(path.join(data,'bots'),{recursive:true})
await fs.writeFile(wrapper,`#!/bin/sh\nif [ -n "$BLINKY_GROK_POLICY_MARKER" ]; then printf '%s' "$BLINKY_GROK_POLICY_MARKER" > "$TEST_MARKER_PATH"; fi\nexec "$BLINKY_TEST_GROK_BIN" "$@"\n`);await fs.chmod(wrapper,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'grok',defaultModelId:'default',defaultMode:'agent',approvalPolicy:'auto-run',backends:{grok:{enabled:true,command:wrapper,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'grok',modelId:'default',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,TEST_MARKER_PATH:marker},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error('Renderer evaluation failed');return v.result.value}
try{
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1000))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 for(let i=0;i<200&&!await evaluate(`!!document.querySelector('#ob-prompt')`);i++)await delay(100)
 await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Reply with HELLO.');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 let policy
 for(let i=0;i<300;i++){try{const file=await fs.readFile(marker,'utf8');if(file)policy=JSON.parse(await fs.readFile(file,'utf8'));if(policy?.event==='session_start')break}catch{}await delay(100)}
 assert.equal(policy?.mode,'default');assert.ok(policy?.sessionId)
 let persisted=false;for(let i=0;i<120;i++){try{const binding=await fs.readFile(path.join(data,'provider-bindings.json'),'utf8');if(binding.includes(policy.sessionId)){persisted=true;break}}catch{}await delay(100)}
 assert.ok(persisted,'app must confirm the mode before persisting and starting the turn')
 console.log(JSON.stringify({realElectron:true,realGrok:true,appHookReportedDefault:true,sessionPersisted:true,modelReplyNotAsserted:true}))
}finally{ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
