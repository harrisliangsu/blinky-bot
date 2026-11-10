// Real mounted Preview with synthetic history, actual clarification RPC and IPC.
// No model account, user transcript or formal app is used.
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'

const repo = process.cwd(), root = process.env.BLINKY_CLARIFICATION_TEST_ROOT
const executable = process.env.BLINKY_CLARIFICATION_EXECUTABLE
assert.ok(root && executable?.startsWith('/'), 'Set the isolated root and mounted Preview executable')
assert.ok(executable.startsWith('/Volumes/') && executable.includes('/BlinkyBot Preview.app/'), 'Use a newly mounted Preview, never an installed/formal app')
await fs.mkdir(root, { recursive: false })
const data = path.join(root, 'data'), work = path.join(root, 'work'), evidence = path.join(root, 'evidence')
for (const dir of [data, work, evidence, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(dir, { recursive: true })
const env = await connectionTestEnvironment(root)
Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data })
const backends = Object.fromEntries(['codex', 'claude', 'claude-code', 'kimi', 'grok', 'pi', 'droid', 'opencode', 'openai', 'anthropic', 'openrouter', 'xai'].map(id => [id, { enabled: false, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'fixture-lead', memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false, approvalPolicy: 'auto-run', localExecutionPolicy: 'always-allow', backends }))
const bot = { id: 'planning-bot', name: 'Planning test', emoji: '🧪', color: '#888888', description: 'Isolated synthetic planning', systemPrompt: 'Controlled test', backendId: 'codex', modelId: 'fixture-lead', followsDefault: false, executionAgent: { backendId: 'codex', modelId: 'fixture-worker' }, tools: ['ask_user'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'planning-home', createdAt: 1, updatedAt: 1 }
await fs.writeFile(path.join(data, 'bots', bot.id + '.json'), JSON.stringify(bot))
const syntheticMessages=[]
for(let i=0;i<260;i++){
 syntheticMessages.push({id:'history-'+i,role:i%2?'assistant':'user',botId:bot.id,content:'合成历史消息 '+i,createdAt:10+i*10})
 if(i%10===0){const id='saved-'+i;syntheticMessages.push({id:'task-clarification-'+id,role:'assistant',botId:bot.id,content:'旧提示不应重复展示',uiOnly:true,createdAt:12+i*10});await fs.mkdir(path.join(data,'task-clarifications'),{recursive:true});await fs.writeFile(path.join(data,'task-clarifications',id+'.json'),JSON.stringify({runtimeId:'old-process',request:{id,taskId:'planning-home',sourceSessionId:'planning-home',executionSessionId:'planning-home',botId:bot.id,questions:[{id:'q',header:'',question:'历史问题 '+i}],answers:{q:['实际回答 '+i]},status:'answered',answeredBy:'user',createdAt:11+i*10,updatedAt:9999}}))}
}
await fs.writeFile(path.join(data,'sessions','planning-home.json'),JSON.stringify({id:'planning-home',cwd:work,mode:'agent',botIds:[bot.id],activeBotId:bot.id,messages:syntheticMessages,todos:[],archived:false,createdAt:1,updatedAt:1}))

const appPath = executable.slice(0, executable.indexOf('.app/') + 4), asar = path.join(appPath, 'Contents/Resources/app.asar')
const asarSha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
assert.equal(asarSha256, process.env.EXPECTED_ASAR_SHA)
assert.equal(JSON.parse(extractFile(asar, 'package.json')).blinkyBuildChannel, 'preview')
const chunks = await fs.readdir(path.join(repo, 'out/main/chunks'))
async function builtFiles(dir) { const items=await fs.readdir(path.join(repo,dir),{withFileTypes:true});return (await Promise.all(items.map(item=>item.isDirectory()?builtFiles(dir+'/'+item.name):[dir+'/'+item.name]))).flat() }
const buildFiles = ['out/main/index.js', 'out/preload/index.cjs', ...chunks.filter(name => name.endsWith('.js')).map(name => 'out/main/chunks/' + name), ...await builtFiles('out/renderer')]
for (const file of buildFiles) assert.ok(extractFile(asar, file).equals(await fs.readFile(path.join(repo, file))), 'Mounted package differs from the local final build: ' + file)
const runtimeChunk = (await Promise.all(chunks.map(async name => ({ name, text: await fs.readFile(path.join(repo, 'out/main/chunks', name), 'utf8') })))).find(value => /\brequestToolClarification as /.test(value.text))?.name
assert.ok(runtimeChunk)
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const port = await freePort(), mainPort = await freePort()
let child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--inspect=127.0.0.1:' + mainPort, '--user-data-dir=' + path.join(root, 'chromium')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = '', sockets = [], rendererErrors = []
child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
async function connect(debugPort, type) {
  let target
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Electron exited: ' + logs.slice(-1200))
    try { target = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find(value => !type || value.type === type); if (target) break } catch {}
    await delay(100)
  }
  assert.ok(target, 'Debugger target must open: ' + logs.slice(-1800))
  const ws = new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let sequence = 0
  const pending = new Map()
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') rendererErrors.push(value.params.exceptionDetails.text)
    const item = pending.get(value.id)
    if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger timeout: ' + method)) }, 20000)
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
  return { send, evaluate }
}
let main, ui
const result={executable,asarSha256,buildFilesVerified:buildFiles,realElectron:true,syntheticOnly:true,realModel:false,checks:[],remotePhysicalDevice:false}
const check=label=>result.checks.push(label)
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){const value=await fn();if(value)return value;await delay(70)}throw Error('Clarification Preview state timed out: '+logs.slice(-1500))}
async function setup(){
 main=await connect(mainPort);ui=await connect(port,'page');await ui.send('Runtime.enable')
 await main.evaluate(`(()=>{const req=process.getBuiltinModule('module').createRequire(process.execPath);globalThis.e=req('electron');globalThis.chunk=req(e.app.getAppPath()+'/out/main/chunks/'+${JSON.stringify(runtimeChunk)});globalThis.fn=(name)=>Object.values(chunk).find(value=>typeof value==='function'&&(value.name===name||value.name.startsWith(name+'$')));return true})()`)
 const runtime=await main.evaluate(`({appPath:e.app.getAppPath(),userData:e.app.getPath('userData'),data:process.env.OPENBOT_DATA_DIR,pid:process.pid})`)
 assert.equal(runtime.appPath,asar);assert.equal(runtime.data,data);result.runtime=runtime
 await until(()=>ui.evaluate(`!!document.querySelector('#ob-prompt')`))
 await ui.evaluate(`document.querySelector('[aria-label="Planning test"]')?.click()`)
 await until(()=>ui.evaluate(`document.querySelector('.ob-transcript-content')?.textContent.includes('合成历史消息 259')`))
}
const domOrder=()=>ui.evaluate(`Array.from(document.querySelector('.ob-transcript-content').children).flatMap(node=>node.dataset.messageId?[node.dataset.messageId]:node.dataset.taskClarificationId?['q:'+node.dataset.taskClarificationId]:[])`)
async function screenshot(name){const shot=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,name+'.png'),Buffer.from(shot.data,'base64'))}
const geometry=()=>ui.evaluate(`(()=>{const s=document.querySelector('.ob-transcript-scroller');return{top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight}})()`)
async function quit(){await main?.evaluate('e.app.quit()').catch(()=>{});for(const socket of sockets)socket.close();sockets=[];await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');throw Error('Owned Preview did not exit normally; no restart attempted')}}
try{
 await setup()
 assert.equal((await domOrder()).at(-1),'history-259');check('historical answered cards do not sink below latest message')
 const cards=await ui.evaluate(`Array.from(document.querySelectorAll('[data-task-clarification-id]')).map(card=>({text:card.textContent,extras:!!card.querySelector('header,h3,button,[role=status]')}))`)
 assert.ok(cards.length);assert.ok(cards.every(card=>card.text.includes('历史问题')&&card.text.includes('实际回答')&&!card.extras));check('answered cards show only exact question and answer')
 const questions=[{id:'first',header:'',question:'已完成离线整理；后续结果面向哪个受众？',kind:'preference',options:[{label:'团队',description:'用于内部协作'},{label:'客户',description:'面向外部客户'}]},{id:'second',header:'',question:'接下来优先哪项？',kind:'preference',options:[{label:'补全报告',description:'先完成已有报告'},{label:'补充图表',description:'先补充现有分析图表'}]}]
 await main.evaluate(`(()=>{globalThis.questionController=new AbortController();globalThis.reply=fn('requestToolClarification')('planning-home','planning-bot',${JSON.stringify(questions)},questionController.signal,'preview-sequential');return true})()`)
 const cardId=await until(()=>ui.evaluate(`document.querySelector('.ob-task-clarification form')?.closest('section').dataset.taskClarificationId`))
 await main.evaluate(`(async()=>{await fn('addNotice')(await fn('getSession')('planning-home'),await fn('getBot')('planning-bot'),'回答期间的后续消息',undefined,'after-question');return true})()`)
 let order=await domOrder();assert.ok(order.indexOf('q:'+cardId)<order.indexOf('after-question'));check('new messages follow pending card in original conversation order')
 const submit=async()=>{await ui.evaluate(`(()=>{const card=document.querySelector('[data-task-clarification-id="${cardId}"]');card.querySelector('input[type=radio]').click();card.querySelector('form').requestSubmit();return true})()`);await delay(200)}
 await submit();await until(()=>ui.evaluate(`document.querySelector('[data-task-clarification-id="${cardId}"] legend')?.textContent.includes('接下来')`));assert.equal(await ui.evaluate(`document.querySelectorAll('[data-task-clarification-id="${cardId}"] fieldset').length`),1);check('one question at a time with partial answer retained')
 await submit();await until(()=>ui.evaluate(`!document.querySelector('[data-task-clarification-id="${cardId}"] form')`))
 const answer=await main.evaluate('reply');assert.deepEqual(answer.answers,{first:['团队'],second:['补全报告']});check('actual IPC answer reaches original request exactly once')
 assert.equal((await domOrder()).at(-1),'after-question');check('answer update never moves prior card to bottom')
 const before=await geometry();assert.ok(before.height-before.top-before.client<=3);check('following view stays at latest')
 const box=await ui.evaluate(`document.querySelector('.ob-transcript-scroller').getBoundingClientRect().toJSON()`)
 await ui.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:box.x+box.width/2,y:box.y+box.height/2,deltaY:-450,deltaX:0});await delay(250)
 const reading=await geometry();assert.ok(reading.top<before.top)
 await main.evaluate(`(async()=>{await fn('addNotice')(await fn('getSession')('planning-home'),await fn('getBot')('planning-bot'),'浏览历史期间的新消息',undefined,'new-while-reading');return true})()`);await delay(200)
 assert.ok(Math.abs((await geometry()).top-reading.top)<4);check('trusted history scrolling is not interrupted by a new message')
 await ui.evaluate(`document.querySelector('.ob-transcript-jump').click()`);await delay(200);const jumped=await geometry();assert.ok(jumped.height-jumped.top-jumped.client<=3);check('Latest explicitly returns to bottom')
 for(const [theme,width,height] of [['light',1120,780],['dark',680,640]]){await ui.evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`);await main.evaluate(`e.BrowserWindow.getAllWindows()[0].setSize(${width},${height})`);await delay(200);assert.equal(await ui.evaluate('document.documentElement.scrollWidth>innerWidth'),false);await screenshot(theme)}
 await ui.send('Page.reload');await until(()=>ui.evaluate(`document.querySelector('.ob-transcript-content')?.textContent.includes('浏览历史期间的新消息')`));assert.equal((await domOrder()).at(-1),'new-while-reading');assert.equal(await ui.evaluate(`document.querySelectorAll('[data-task-clarification-id="${cardId}"]').length`),1);check('renderer refresh retains exact order and one answered card')
 await quit()
 child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--inspect=127.0.0.1:'+mainPort,'--user-data-dir='+path.join(root,'chromium')],{cwd:repo,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value)
 await setup();assert.equal((await domOrder()).at(-1),'new-while-reading');assert.equal(await ui.evaluate(`document.querySelectorAll('[data-task-clarification-id="${cardId}"]').length`),1);check('real Preview restart preserves question/answer and original timeline')
 await screenshot('restarted');assert.deepEqual(rendererErrors,[]);result.rendererErrors=rendererErrors;result.ok=true
}catch(error){result.ok=false;result.error=error.stack}
finally{await quit().catch(error=>{result.shutdownError=error.message;result.ok=false});result.exit={code:child.exitCode,signal:child.signalCode};await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(evidence,'electron.log'),logs);console.log(JSON.stringify({ok:result.ok,checks:result.checks.length,evidence,error:result.error}));process.exitCode=result.ok?0:1}
