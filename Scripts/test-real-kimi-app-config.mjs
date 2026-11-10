/** Isolated Electron + real Kimi ACP; report only selected session options. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.env.BLINKY_TEST_KIMI_BIN) throw new Error('Set BLINKY_TEST_KIMI_BIN for this explicit live CLI test.');
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-real-kimi-app-')),data=path.join(root,'data'),wrapper=path.join(root,'kimi'),trace=path.join(root,'trace')
await fs.mkdir(path.join(data,'bots'),{recursive:true})
await fs.writeFile(wrapper,`#!${process.execPath}\n`+String.raw`
const {spawn}=require('node:child_process'),readline=require('node:readline'),fs=require('node:fs');const child=spawn(process.env.BLINKY_TEST_KIMI_BIN,process.argv.slice(2),{stdio:['pipe','pipe','ignore']});const ids=new Map();readline.createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line);if(m.method==='session/set_config_option')ids.set(m.id,m.params.configId)}catch{}child.stdin.write(line+'\n')});readline.createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(ids.has(m.id)){const key=ids.get(m.id),v=m.result?.configOptions?.find(x=>x.id===key)?.currentValue;fs.appendFileSync(process.env.KIMI_CONFIG_TRACE,JSON.stringify({key,value:v,error:!!m.error})+'\n');ids.delete(m.id)}}catch{}process.stdout.write(line+'\n')});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code||0));
`);await fs.chmod(wrapper,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'kimi',defaultModelId:'default',defaultMode:'agent',approvalPolicy:'auto-run',backends:{kimi:{enabled:true,command:wrapper,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'kimi',modelId:'kimi-code/k3',thinking:'high',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,KIMI_CONFIG_TRACE:trace},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error('Renderer evaluation failed');return v.result.value}
try{
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1000))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 for(let i=0;i<200&&!await evaluate(`!!document.querySelector('#ob-prompt')`);i++)await delay(100)
 await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Reply with HELLO.');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 let entries=[];for(let i=0;i<300;i++){try{entries=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);if(entries.some(x=>x.key==='thinking'))break}catch{}await delay(100)}
 assert.ok(entries.some(x=>x.key==='mode'&&x.value==='default'&&!x.error));assert.ok(entries.some(x=>x.key==='model'&&x.value==='kimi-code/k3'&&!x.error));assert.ok(entries.some(x=>x.key==='thinking'&&x.value==='high'&&!x.error))
 console.log(JSON.stringify({realElectron:true,realKimi:true,modeConfirmed:true,modelConfirmed:true,thinkingConfirmed:true,modelReplyNotAsserted:true}))
}finally{ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
