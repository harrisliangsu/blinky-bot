/** Real Electron with a fake Kimi or Grok ACP permission request. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const cli=process.env.BLINKY_TEST_CLI==='grok'?'grok':'kimi'
const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),`blinky-${cli}-gate-`)),data=path.join(root,'data'),fake=path.join(root,cli),protectedFile=path.join(root,'protected'),trace=path.join(root,'trace'),mcpTrace=path.join(root,'mcp-trace')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.writeFile(protectedFile,'fixture')
await fs.writeFile(fake,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),readline=require('node:readline');const args=process.argv.slice(2);if(args.includes('--version')||args[0]==='version'){console.log(process.env.TEST_CLI+' 1.0');process.exit()}const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),parent=process.ppid;let promptId;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===900){const allowed=m.result?.outcome?.optionId==='yes';fs.writeFileSync(process.env.KIMI_TRACE,allowed?'allowed':'rejected');if(allowed)fs.writeFileSync(process.env.KIMI_PROTECTED,'changed');send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:allowed?'permission allowed':'permission denied'}}}});send({id:promptId,result:{stopReason:'end_turn'}})}else if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],agentCapabilities:{mcpCapabilities:{http:true},promptCapabilities:{image:true}}}});else if(m.method==='authenticate')send({id:m.id,result:{}});else if(m.method==='session/new'){fs.writeFileSync(process.env.MCP_TRACE,String(m.params.mcpServers.some(s=>s.name==='openbot'&&s.type==='http'&&s.headers?.some(h=>h.name==='Authorization'))));if(process.env.TEST_CLI==='grok')fs.writeFileSync(process.env.BLINKY_GROK_POLICY_MARKER,JSON.stringify({event:'session_start',mode:'default',sessionId:'cli-test'}));send({id:m.id,result:{sessionId:'cli-test'}})}else if(m.method==='session/set_config_option')send({id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value}]}});else if(m.method==='session/prompt'){promptId=m.id;send({id:900,method:'session/request_permission',params:{toolCall:{kind:'edit',title:'Modify protected fixture'},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}})}});
`);await fs.chmod(fake,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:cli,defaultModelId:'default',defaultMode:'agent',approvalPolicy:'auto-run',backends:{[cli]:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:cli,modelId:'default',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
const app=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,KIMI_PROTECTED:protectedFile,KIMI_TRACE:trace,MCP_TRACE:mcpTrace,TEST_CLI:cli},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)
let ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const v=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evaluate(expression))return;await delay(100)}throw Error('timeout '+expression+' logs '+logs.slice(-1400))}
try {
 let targets;for(let i=0;i<300;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('no renderer '+logs.slice(-1000))
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 await wait(`!!document.querySelector('#ob-prompt')`);await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'test native permission');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
 await wait(`!!document.querySelector('.ob-transcript .ob-approval')`,45000);assert.equal(await fs.readFile(protectedFile,'utf8'),'fixture')
 await delay(600);await evaluate(`[...document.querySelectorAll('.ob-approval button')].find(b=>b.textContent.includes('拒绝')).click()`)
 await wait(`document.body.innerText.includes('未获批准')`)
 const received=await fs.readFile(trace,'utf8').catch(()=>null)
 if(received)assert.equal(received,'rejected') // The process can stop during its own trace write.
 assert.equal(await fs.readFile(protectedFile,'utf8'),'fixture');assert.equal(await fs.readFile(mcpTrace,'utf8'),'true')
 console.log(JSON.stringify({realElectron:true,cliMocked:cli,gatewayPassed:true,nativePermissionWaited:true,rejectionNotExecuted:true}))
} finally {ws?.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true})}
