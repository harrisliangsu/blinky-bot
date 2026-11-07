// Pending isolated Linux GUI/CI acceptance. Never run on the user Mac.
// Requires a dedicated VM/container with its own desktop, HOME and accounts.
// No real model, credentials, Computer Use, installed app or external service.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'linux' || process.env.BLINKY_ISOLATED_GUI !== '1') {
  throw new Error('Electron acceptance requires an independently provisioned isolated Linux GUI/CI runner. Local macOS execution is prohibited.')
}
const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-reply-progress-electron-'))
const data = path.join(root, 'data')
const real = false
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
const fake = path.join(root, 'fake-codex')
await fs.writeFile(fake, String.raw`#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const root = ${JSON.stringify(root)};
if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const gateway = process.argv.find(value=>value.startsWith('mcp_servers.openbot='))??'';
const gatewayUrl = gateway.match(/url="([^"]+)"/)?.[1];
const tokenName = gateway.match(/bearer_token_env_var="([^"]+)"/)?.[1];
let active, sequence = 0; const thread = 'test-thread-'+process.pid;
const complete = () => { if (!active) return; const turn=active.id; active=null; send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[]}}}); };
const say = (phase, text, suffix='') => { if (!active) return; const id=active.id+phase+suffix; send({method:'item/started',params:{item:{type:'agentMessage',id,phase,text:''}}}); send({method:'item/agentMessage/delta',params:{itemId:id,delta:text}}); };
setInterval(() => { if (active?.scenario==='progress' && fs.existsSync(root+'/release-progress')) { active.scenario='finishing'; say('final_answer','真实正文第一段'); setTimeout(()=>{say('commentary','正文后的公开进度，不应重现头像','after'); say('final_answer','真实正文第二段','second'); complete()},700); } },50).unref();
setInterval(() => { if (active?.scenario==='unphased' && fs.existsSync(root+'/release-unphased')) {send({method:'item/agentMessage/delta',params:{itemId:active.id+'no-phase',delta:'，第二段'}});complete()} },50).unref();
readline.createInterface({input:process.stdin}).on('line', async line => {
 const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{}});
 else if(r.method==='model/list') send({id:r.id,result:{data:[{model:'test-model',displayName:'Test Model'}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:thread}}});
 else if(r.method==='turn/start') {
  const text=r.params.input.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  const scenario=[...text.matchAll(/SCENARIO:([a-z-]+)/g)].at(-1)?.[1]??'instant';
  active={id:'turn-'+(++sequence),scenario}; const id=active.id;
  send({id:r.id,result:{turn:{id}}}); send({method:'turn/started',params:{turn:{id},threadId:thread}});
  if (scenario==='hold'||scenario==='background') return;
  if (scenario==='unphased'||scenario==='unphased-error') {
   say('commentary','无 phase 正文之前的公开进度');
   send({method:'item/reasoning/textDelta',params:{delta:'PRIVATE_REASONING_NEVER_SHOW'}});
   setTimeout(()=>{if(active?.id!==id)return;send({method:'item/agentMessage/delta',params:{itemId:id+'no-phase',delta:'无 phase 的真实流式正文'}});if(scenario==='unphased-error')setTimeout(()=>{send({method:'error',params:{error:{message:'simulated unphased stream failure'},willRetry:false}});complete()},400)},400);
  } else if (scenario==='progress'||scenario==='progress-stop') {
   send({method:'item/reasoning/textDelta',params:{delta:'PRIVATE_REASONING_NEVER_SHOW'}});
   say('commentary','正在核对模型公开的进度');
  } else if (scenario==='delegate') {
   const result=await fetch(gatewayUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[tokenName]},body:JSON.stringify({jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'delegate_task',arguments:{prompt:'SCENARIO:background',title:'独立后台测试'}}})});
   const reply=await result.json();
   if(!result.ok||reply.error||reply.result?.isError) {send({method:'error',params:{error:{message:'test delegation rejected'},willRetry:false}});complete();return;}
   say('final_answer','已派发独立执行会话');complete();
  } else if (scenario==='failure') {
   say('commentary','连接异常前的公开进度'); say('partial_answer','异常前已生成的正文');
   setTimeout(()=>{send({method:'error',params:{error:{message:'simulated stream failure'},willRetry:false}});complete()},100);
  } else if (scenario==='startup-failure') {
   send({method:'error',params:{error:{message:'simulated startup failure'},willRetry:false}});complete();
  } else if (scenario==='reasoning-only') {
   send({method:'item/reasoning/textDelta',params:{delta:'PRIVATE_REASONING_NEVER_SHOW'}});complete();
  } else if (scenario==='empty') complete();
  else if (scenario==='nonstream') {
   send({method:'item/completed',params:{item:{type:'agentMessage',id:id+'final',phase:'final_answer',text:'非流式接口真实正文'}}});complete();
  } else { say('final_answer','简短正文'); complete(); }
 } else if(r.method==='turn/steer') {
  send({id:r.id,result:{turnId:active?.id}}); say('commentary','已结合追加输入继续核对','followup');
 } else if(r.method==='turn/interrupt') {send({id:r.id,result:{}});complete();}
 else if(r.id!==undefined) send({id:r.id,result:{}});
});
`, { mode: 0o700 })

// Exercise the existing generic API adapter too: SSE and an ordinary JSON reply.
const api = http.createServer(async (request, response) => {
  if (request.url?.split('?')[0].endsWith('/models')) return response.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
  if (request.method !== 'POST') { response.statusCode = 404; return response.end() }
  let body = ''; for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  const text = parsed.messages?.at(-1)?.content ?? ''
  if (request.url?.endsWith('/messages')) {
    if (JSON.stringify(text).includes('JSON')) {
      response.setHeader('Content-Type', 'application/json')
      return response.end(JSON.stringify({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_API_REASONING' }, { type: 'text', text: 'Anthropic JSON body' }] }))
    }
    response.setHeader('Content-Type', 'text/event-stream')
    response.write('data: '+JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_API_REASONING' } })+'\n\n')
    response.write('data: '+JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Anthropic streaming body' } })+'\n\n')
    return setTimeout(() => response.end('data: '+JSON.stringify({ type: 'message_stop' })+'\n\n'), 1000)
  }
  if (String(text).includes('JSON')) {
    response.setHeader('Content-Type', 'application/json')
    return response.end(JSON.stringify({ choices: [{ message: { content: 'API JSON 正文', reasoning_content: 'PRIVATE_API_REASONING' } }] }))
  }
  response.setHeader('Content-Type', 'text/event-stream')
  response.write('data: '+JSON.stringify({ choices: [{ delta: { reasoning_content: 'PRIVATE_API_REASONING', content: 'API 流式第一段' } }] })+'\n\n')
  setTimeout(() => {
    response.write('data: '+JSON.stringify({ choices: [{ delta: { content: '第二段' } }] })+'\n\n')
    response.end('data: [DONE]\n\n')
  }, 1000)
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${api.address().port}/v1`
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', memoryExtraction: 'off', notifications: false, defaultBackendId: 'codex', defaultModelId: real ? 'default' : 'test-model', approvalPolicy: 'auto-run', backends: {
  codex: { enabled: true, added: true, command: real ? path.join(os.homedir(), '.local/bin/codex') : fake },
  'custom-chat-test': { enabled: true, added: true, providerName: 'Chat test', providerProtocol: 'openai', baseUrl, apiKey: 'local-test-only', credentialOrigin: new URL(baseUrl).origin },
  'custom-anthropic-test': { enabled: true, added: true, providerName: 'Anthropic test', providerProtocol: 'anthropic', baseUrl: new URL(baseUrl).origin, apiKey: 'local-test-only', credentialOrigin: new URL(baseUrl).origin }
} }))
for (const [index, name] of ['Alpha', 'Beta', 'Api', 'Anthropic'].entries()) {
  await fs.writeFile(path.join(data, 'bots', name.toLowerCase()+'.json'), JSON.stringify({ id: name.toLowerCase(), name, description: 'isolated chat test', systemPrompt: 'Follow the user request exactly. Never expose private reasoning.', emoji: '✨', color: '#7c9cff', backendId: name==='Anthropic'?'custom-anthropic-test':name==='Api'?'custom-chat-test':'codex', modelId: real && name!=='Api'?'default':'test-model', followsDefault: false, tools: name==='Alpha'&&!real?['delegate_task']:[], ...(name==='Alpha'&&!real?{executionAgent:{backendId:'codex',modelId:'test-model'}}:{}), computerUse: false, computerTarget: { kind: 'local' }, createdAt: index+1, updatedAt: index+1 }))
}
const port = await new Promise(resolve => { const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))}) })
const electron = path.join(repo, 'node_modules/electron/dist/electron')
const testHome = path.join(root, 'home'); await fs.mkdir(testHome)
const allowedEnv = Object.fromEntries(['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { cwd: repo, env: { ...allowedEnv, PATH: path.dirname(process.execPath)+':/usr/bin:/bin', HOME: testHome, XDG_CONFIG_HOME: path.join(testHome,'.config'), XDG_CACHE_HOME: path.join(testHome,'.cache'), BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', ws, sequence = 0
app.stdout.on('data', value => { logs += value }); app.stderr.on('data', value => { logs += value })
const pending = new Map()
function command(method, params={}) { const id=++sequence; return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))}) }
async function evaluate(expression) { const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
async function wait(expression, timeout=30000) { const deadline=Date.now()+timeout; while(Date.now()<deadline){if(await evaluate(expression))return;await delay(75)} throw Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText.slice(-1600)')+'\n'+logs.slice(-1800)) }
const current = `(async()=>{const b=(await window.openbot.bots.list()).find(b=>b.id==='alpha');return b?.activeConversationId})()`
const running = `(async()=>{const id=await ${current};return id&&window.openbot.agent.isRunning(id)})()`
const transcript = `document.querySelector('.ob-transcript-content')`
async function submit(text) { await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`) }
async function select(name) { await evaluate(`Array.from(document.querySelectorAll('.ob-side-item-main')).find(e=>e.textContent.includes(${JSON.stringify(name)})).click()`);await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes(${JSON.stringify(name)}) && !!document.querySelector('#ob-prompt')`) }
async function snapshot(name) { const result=await command('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,name+'.png'),Buffer.from(result.data,'base64')) }
async function checkNoFabricatedStatus() {
  assert.equal(await evaluate(`${transcript}?.innerText.includes('收到，我') || !!document.querySelector('.ob-header .ob-working, .ob-transcript .ob-working')`), false)
  assert.equal(await evaluate(`document.body.innerText.includes('PRIVATE_REASONING_NEVER_SHOW') || document.body.innerText.includes('PRIVATE_API_REASONING')`), false)
}

const report = { realElectron: false, realModel: false, syntheticOnly: true, packagedPreview: false, checks: [], pid: app.pid, argv: [electron,'.'], root }
try {
  let targets
  for(let attempt=0;attempt<300;attempt++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}
  assert.ok(targets?.some(t=>t.type==='page'),logs.slice(-1800))
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  ws.onmessage=event=>{const v=JSON.parse(event.data);if(v.id&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result)}}
  report.realElectron = true
  await wait(`!!document.querySelector('#ob-prompt')`)
  await wait(`window.openbot.backends.list().then(items=>items.some(item=>item.id==='codex'&&item.status==='available'))`,45000)
  await select('Alpha')
  await evaluate(`window.chatEvents=[];window.openbot.on(event=>window.chatEvents.push(event))`)
  const indicator = `document.querySelector('.ob-reply-progress')`
  const noChatStop = async()=>assert.equal(await evaluate(`!!document.querySelector('.ob-transcript-working') || Array.from(document.querySelectorAll('.ob-transcript button')).some(b=>/停止工作|Stop work/.test(b.textContent))`),false)
  const stopThroughExistingControl = async()=>evaluate(`(async()=>window.openbot.agent.stop(await ${current}))()`)
  await submit('SCENARIO:hold'); await wait(`${indicator}?.textContent.includes('正在回复')`)
  await noChatStop(); assert.equal(await evaluate(`document.querySelector('#ob-prompt').disabled`),false)
  await stopThroughExistingControl(); await wait(`!${indicator}`)
  report.checks.push('neutral-wait-and-existing-cancel-api')
  await submit('SCENARIO:progress'); await wait(`${indicator}?.textContent.includes('正在回复')`)
  await wait(`${transcript}.innerText.includes('正在核对模型公开的进度')`)
  await submit('follow-up while active'); await wait(`${transcript}.innerText.includes('已结合追加输入')`)
  await select('Beta'); assert.equal(await evaluate(`!!${indicator}`),false)
  await select('Alpha'); await wait(`!!${indicator}`)
  await fs.writeFile(path.join(root,'release-progress'),'go')
  await wait(`${transcript}.innerText.includes('真实正文第一段')`)
  assert.equal(await evaluate(`!!${indicator}`),true)
  await snapshot('stream-light')
  await wait(`(async()=>!await ${running})()`); await wait(`!${indicator}`)
  await wait(`${transcript}.innerText.includes('正文后的公开进度') && ${transcript}.innerText.includes('真实正文第二段')`)
  await noChatStop(); await checkNoFabricatedStatus()
  report.checks.push('streaming-prose-milestones-followup-return-and-done')
  await submit('SCENARIO:unphased'); await wait(`${transcript}.innerText.includes('无 phase 的真实流式正文')`)
  assert.equal(await evaluate(`!!${indicator}`),true)
  await fs.writeFile(path.join(root,'release-unphased'),'go'); await wait(`!${indicator}`)
  for(const scenario of ['nonstream','empty','reasoning-only','startup-failure','failure','unphased-error']){
    await submit('SCENARIO:'+scenario)
    await wait(`window.chatEvents.some(e=>e.type==='message-start'&&e.message.role==='user'&&e.message.content===${JSON.stringify('SCENARIO:'+scenario)})`)
    await wait(`(async()=>!await ${running})()`); assert.equal(await evaluate(`!!${indicator}`),false)
    await checkNoFabricatedStatus()
  }
  await wait(`${transcript}.innerText.includes('simulated stream failure') && ${transcript}.innerText.includes('异常前已生成的正文')`)
  report.checks.push('unphased-nonstream-empty-startup-and-partial-errors')
  await submit('SCENARIO:delegate')
  await wait(`window.openbot.tasks.list().then(items=>items.some(t=>t.title==='独立后台测试'&&t.status==='running'))`)
  const task=await evaluate(`window.openbot.tasks.list().then(items=>items.find(t=>t.title==='独立后台测试'))`)
  await wait(`(async()=>!await ${running})()`); await wait(`!${indicator}`)
  await noChatStop(); assert.equal(await evaluate(`${transcript}.innerText.includes('后台任务进行中')`),false)
  assert.equal(await evaluate(`window.openbot.tasks.list().then(items=>items.find(t=>t.id===${JSON.stringify(task.id)})?.status)`),'running')
  await evaluate(`window.openbot.tasks.cancel(${JSON.stringify(task.id)})`)
  report.checks.push('background-task-does-not-extend-foreground-status')
  for(const [bot,body] of [['Api','API 流式第一段'],['Anthropic','Anthropic streaming body']]){
    await select(bot); await submit('SSE'); await wait(`${transcript}.innerText.includes(${JSON.stringify(body)})`)
    await wait(`!!${indicator}`); await wait(`!${indicator}`); await checkNoFabricatedStatus()
    await submit('JSON'); await wait(`${transcript}.innerText.includes(${JSON.stringify(bot==='Api'?'API JSON 正文':'Anthropic JSON body')})`)
    await wait(`!${indicator}`)
  }
  report.checks.push('openai-anthropic-sse-and-json')
  await select('Alpha'); await submit('SCENARIO:hold'); await wait(`!!${indicator}`)
  assert.equal(await evaluate(`${indicator}.getAttribute('role')`),'status')
  assert.equal(await evaluate(`${indicator}.getAttribute('aria-atomic')`),'true')
  await evaluate(`window.openbot.settings.update({theme:'dark'})`)
  await command('Emulation.setDeviceMetricsOverride',{width:720,height:520,deviceScaleFactor:1,mobile:false})
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await snapshot('dark-narrow-reduced-motion')
  assert.equal(await evaluate(`${transcript}.scrollWidth>${transcript}.clientWidth+1`),false)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ob-reply-progress-pulse')).animationName`),'none')
  await stopThroughExistingControl(); await wait(`!${indicator}`)
  report.checks.push('narrow-dark-reduced-motion-and-accessibility-attributes')
  report.ok = true
} catch(error){ report.error=String(error?.stack??error); throw error }
finally {
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n')
  await fs.writeFile(path.join(root,'electron.log'),logs)
  ws?.close(); app.kill('SIGTERM'); await delay(500); if(app.exitCode===null)app.kill('SIGKILL')
  api.closeAllConnections(); await new Promise(resolve=>api.close(resolve))
  console.log(JSON.stringify(report))
}
