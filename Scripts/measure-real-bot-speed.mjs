/** Small real-Codex measurements in an isolated application store. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-speed-')),data=path.join(root,'data'),codex=path.join(os.homedir(),'.local/bin/codex')
await fs.mkdir(path.join(data,'bots'),{recursive:true})
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({language:'zh-CN',defaultBackendId:'codex',defaultModelId:'gpt-6.1-sol',defaultMode:'agent',approvalPolicy:'ask-every-time',backends:{codex:{enabled:true,command:codex,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',description:'benchmark',systemPrompt:'Follow the user request exactly.',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'gpt-6.1-sol',thinking:'low',followsDefault:false,executionAgent:{backendId:'codex',modelId:'gpt-6.1-sol',thinking:'high'},tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});let logs='';app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function wait(expression,ms=90000){const end=Date.now()+ms;while(Date.now()<end){const v=await evaluate(expression);if(v)return v;await delay(100)}throw Error('measurement timed out: '+logs.slice(-1000))}
try{
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer')
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 await wait(`!!document.querySelector('#ob-prompt')`);await wait(`window.openbot.backends.list().then(a=>a.some(x=>x.id==='codex'&&x.status==='available'))`,45000)
 const sessionId=await evaluate(`window.openbot.bots.list().then(bs=>bs.find(b=>b.id==='blinky').activeConversationId)`)
 const choices=process.env.BLINKY_BENCH_COMPARE_MODELS==='1'?[{model:'gpt-6.1-sol',effort:'low'},{model:'gpt-6-luna',effort:'low'},{model:'gpt-6.1-sol',effort:'low'},{model:'gpt-6-luna',effort:'low'}]:['low','high','low','high'].map(effort=>({model:'gpt-6.1-sol',effort}))
 for(const {model,effort} of choices){
  const ok=await evaluate(`window.openbot.bots.update('blinky',{modelId:${JSON.stringify(model)},thinking:${JSON.stringify(effort)}}).then(r=>r.ok&&r.bot.modelId===${JSON.stringify(model)})`);if(!ok)throw Error('failed to set benchmark model or effort')
  await evaluate(`(()=>{window.__latency={start:performance.now(),effort:${JSON.stringify(effort)}};window.__assistantIds=new Set();window.__off?.();window.__off=window.openbot.on(e=>{if((e.sessionId??e.session?.id)!==${JSON.stringify(sessionId)})return;if(e.type==='run-started')window.__latency.started=performance.now();if(e.type==='message-start'&&e.message.role==='assistant')window.__assistantIds.add(e.message.id);if(e.type==='text-delta'&&window.__assistantIds.has(e.messageId)&&!window.__latency.firstDelta)window.__latency.firstDelta=performance.now();if(e.type==='message-end'&&window.__assistantIds.has(e.messageId)&&!e.internal&&!window.__latency.visible)window.__latency.visible=performance.now();if(e.type==='error')window.__latency.error=e.message;if(e.type==='done')window.__latency.done=performance.now()});return window.openbot.agent.send(${JSON.stringify(sessionId)},'Reply with OK only. Do not use any tools.')})()`)
  await wait(`window.__latency?.done`)
  const sample=await evaluate(`(()=>{const x=window.__latency;return {effort:x.effort,started:x.started===undefined?null:Math.round(x.started-x.start),firstDelta:x.firstDelta===undefined?null:Math.round(x.firstDelta-x.start),visible:x.visible===undefined?null:Math.round(x.visible-x.start),done:Math.round(x.done-x.start),error:!!x.error}})()`)
  console.log(JSON.stringify({model,...sample}))
  if(sample.error||sample.visible===null)throw Error('real Codex did not produce a visible reply')
  await delay(300)
 }
}finally{ws?.close();app.kill('SIGTERM');await delay(800);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
