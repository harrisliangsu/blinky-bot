// Actual packaged Electron UI/IPC/scheduler/storage, isolated fake Codex only.
// Requires a coordinator-selected bundle; never builds or touches a formal store.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { connectInspector, inspectInstalledApp } from './inspect-installed-app.mjs'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'

const bundle = process.env.BLINKY_TEST_APP_BUNDLE
assert.ok(bundle, 'BLINKY_TEST_APP_BUNDLE is required')
assert.notEqual(path.resolve(bundle), '/Applications/BlinkyBot.app', 'Use the isolated candidate or mounted Preview')
const root = process.env.BLINKY_TEST_EVIDENCE_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-routine-triggers-'))
const data = path.join(root, 'data'), work = path.join(root, 'workspace'), uiFolder = path.join(work, 'ui-watch'), toolFolder = path.join(work, 'tool-watch'), trace = path.join(root, 'trace.jsonl'), fake = path.join(root, 'fixture-codex.cjs')
await fs.mkdir(path.join(data, 'bots'), { recursive: true }); await fs.mkdir(path.join(data, 'sessions'), { recursive: true })
await fs.mkdir(path.join(uiFolder, 'nested'), { recursive: true }); await fs.mkdir(toolFolder, { recursive: true })
await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli 0.167.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],variable=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');const owner=process.ppid;setInterval(()=>{try{process.kill(owner,0)}catch{process.exit()}},200).unref();
async function call(name,arguments_){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[variable]},body:JSON.stringify({jsonrpc:'2.0',id:100+(n++),method:'tools/call',params:{name,arguments:arguments_}})});const r=await response.json();if(!response.ok||r.error||r.result?.isError)throw Error('fixture routine gateway rejected '+name)}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line),p=r.params||{};if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'routine-fixture',displayName:'Routine fixture'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:p.threadId||'fixture-'+process.pid},approvalPolicy:p.approvalPolicy||'never',approvalsReviewer:p.approvalsReviewer||'user',sandbox:{type:p.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false}}});else if(r.method==='turn/start'){const t='turn-'+(++n),text=p.input?.[0]?.text||'',threadId=p.threadId;send({id:r.id,result:{turn:{id:t}}});send({method:'turn/started',params:{threadId,turn:{id:t}}});let tag='';if(text.trim().endsWith('ROUTINE_TOOL_CREATE')){await call('schedule_once',{name:'Tool once',instruction:'TOOL_ONCE_TOKEN',at:Date.now()+3000,lateMinutes:1});await call('watch_folder',{name:'Tool folder',instruction:'TOOL_FOLDER_TOKEN',path:process.env.ROUTINE_TOOL_FOLDER});tag='TOOLS_CREATED'}else tag=['UI_ONCE_TOKEN','UI_FOLDER_TOKEN','TOOL_ONCE_TOKEN','TOOL_FOLDER_TOKEN'].find(x=>text.trim().endsWith(x))||'';if(tag)fs.appendFileSync(process.env.ROUTINE_TRACE,JSON.stringify({tag})+'\n');const answer=tag?'Isolated routine fixture returned '+tag: '[]';send({method:'item/started',params:{threadId,item:{type:'agentMessage',id:'m-'+t,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{threadId,itemId:'m-'+t,delta:answer}});send({method:'turn/completed',params:{threadId,turn:{id:t,status:'completed',items:[]}}})}else if(r.id)send({id:r.id,result:{}})}catch(error){fs.appendFileSync(process.env.ROUTINE_TRACE,JSON.stringify({error:error.message})+'\n');process.exitCode=1}})
`)
await fs.chmod(fake, 0o700)
const backends = Object.fromEntries(['codex', 'claude', 'kimi', 'grok', 'pi', 'droid', 'opencode', 'openai', 'anthropic', 'openrouter', 'xai'].map(id => [id, { enabled: id === 'codex', command: fake, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'routine-fixture', approvalPolicy: 'auto-run', memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false, backends }))
const botId = 'routine-fixture', sessionId = 'routine-home'
await fs.writeFile(path.join(data, 'bots', botId + '.json'), JSON.stringify({ id: botId, name: 'Routine fixture', color: '#888888', systemPrompt: 'Use only the fixture response.', backendId: 'codex', modelId: 'routine-fixture', followsDefault: false, tools: ['schedule_routine', 'read_file', 'list_dir'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: sessionId, createdAt: 1, updatedAt: 1 }))
await fs.writeFile(path.join(data, 'sessions', sessionId + '.json'), JSON.stringify({ id: sessionId, title: 'Routine fixture', cwd: work, mode: 'agent', botIds: [botId], activeBotId: botId, messages: [], todos: [], createdAt: 1, updatedAt: 1 }))
const executable = (await promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Contents/Info.plist')])).stdout.trim()
const reservePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
let child, client, port, logs = ''
let currentStage = 'fixture-created'
const stage = async phase => { currentStage = phase; await fs.appendFile(path.join(root, 'stages.jsonl'), JSON.stringify({ phase, pid: child?.pid, at: Date.now() }) + '\n') }
const environment = await connectionTestEnvironment(root)
await fs.symlink(process.execPath, path.join(root, 'bin', 'node'))
async function launch() {
  port = await reservePort()
  child = spawn(path.join(bundle, 'Contents/MacOS', executable), [`--inspect=127.0.0.1:${port}`], { env: { ...environment, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data, BLINKY_TEST_WATCH_POLL_MS: '100', ROUTINE_TRACE: trace, ROUTINE_TOOL_FOLDER: toolFolder }, stdio: ['ignore', 'pipe', 'pipe'] })
  await stage('app-started')
  child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Packaged fixture exited before inspector readiness')
    try { client = await connectInspector(port); break } catch {}
    await delay(100)
  }
  assert.ok(client, 'Packaged app inspector must start')
  await stage('inspector-connected')
  let ready = false, readinessError
  const readyDeadline = Date.now() + 30000
  while (Date.now() < readyDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Packaged fixture exited before main/window readiness')
    try {
      ready = await client.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');if(!e.app.isReady())return false;const w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());return Boolean(w&&!w.webContents.isLoadingMainFrame()&&decodeURIComponent(new URL(w.webContents.getURL()).pathname)===${JSON.stringify(path.join(bundle, 'Contents/Resources/app.asar/out/renderer/index.html'))})})()`)
      if (ready) break
    } catch (error) { readinessError = String(error) }
    await delay(100)
  }
  assert.ok(ready, 'Main/window readiness did not reach the exact ASAR renderer: ' + (readinessError ?? 'not ready'))
  await stage('main-window-ready')
  const isolation = await client.evaluate(`({home:process.env.HOME,osHome:process.getBuiltinModule('os').homedir(),codexHome:process.env.CODEX_HOME,xdgConfig:process.env.XDG_CONFIG_HOME})`)
  assert.equal(isolation.home, environment.HOME); assert.equal(isolation.osHome, environment.HOME)
  assert.equal(isolation.codexHome, environment.CODEX_HOME); assert.equal(isolation.xdgConfig, environment.XDG_CONFIG_HOME)
  await wait(`!!document.querySelector('#ob-prompt')`)
  await stage('composer-ready')
}
const ui = expression => client.evaluate(`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron'),w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());if(!w)return null;return w.webContents.executeJavaScript(${JSON.stringify(expression)})})()`)
async function wait(expression, milliseconds = 25000) { const end = Date.now() + milliseconds; while (Date.now() < end) { if (await ui(expression).catch(() => false)) return; await delay(100) } throw Error('Timed out waiting for isolated routine boundary: ' + expression) }
async function stop() {
  if (client) { await client.evaluate(`(()=>{setTimeout(()=>process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit(),150);return true})()`).catch(() => {}); client.close(); client = undefined }
  for (let i = 0; child && child.exitCode === null && child.signalCode === null && i < 150; i++) await delay(100)
  if (child && child.exitCode === null && child.signalCode === null) throw Error('Isolated app did not quit normally')
}
const setInput = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing fixture input');const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const result = { ok: false, bundle, isolatedData: data, fakeCli: true, realAccounts: false, externalMessages: false }
try {
  await launch()
  await stage('loaded-source-observer')
  const observer = await inspectInstalledApp({ port, appPath: path.join(bundle, 'Contents/Resources/app.asar'), dataDir: data })
  await fs.writeFile(path.join(root, 'loaded-source.json'), JSON.stringify(observer, null, 2))
  await stage('ui-once-create')
  await ui(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}))`)
  await wait(`!![...document.querySelectorAll('.ob-palette-item')].find(e=>e.textContent.trim()==='Routines')`)
  await ui(`[...document.querySelectorAll('.ob-palette-item')].find(e=>e.textContent.trim()==='Routines').click()`)
  await wait(`!!document.querySelector('.ob-routine-create > summary')`)
  await ui(`document.querySelector('.ob-routine-create > summary').click()`)
  await setInput('#ob-routine-create-name', 'UI once'); await setInput('#ob-routine-create-instruction', 'UI_ONCE_TOKEN'); await setInput('#ob-routine-create-kind', 'once')
  const now = new Date(), at = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await setInput('#ob-routine-create-at', at)
  await ui(`document.querySelector('.ob-routine-create .ob-routine-timing-options').open=true`)
  await setInput('.ob-routine-create .ob-routine-timing-options input[type=number]', '1')
  await setInput('#ob-routine-create-notify', 'quiet')
  await ui(`document.querySelector('.ob-routine-create form').requestSubmit()`)
  await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='UI once'&&r.lastRunState==='finished'))`)
  const once = await ui(`window.openbot.routines.list().then(rs=>rs.find(r=>r.name==='UI once'))`)
  assert.equal(once.notifyPolicy, 'quiet'); result.onceCreatedAndExecutedThroughUi = true
  await stage('ui-folder-create')
  await setInput('#ob-routine-create-name', 'UI folder'); await setInput('#ob-routine-create-instruction', 'UI_FOLDER_TOKEN'); await setInput('#ob-routine-create-kind', 'folder_change'); await setInput('#ob-routine-create-folder', uiFolder)
  await ui(`document.querySelector('.ob-routine-create form').requestSubmit()`)
  await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='UI folder'&&r.watchCursor))`)
  await fs.writeFile(path.join(uiFolder, 'nested', 'metadata-fixture'), 'Opaque fixture only')
  await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='UI folder'&&r.lastRunState==='finished'))`)
  result.folderCreatedAndTriggeredThroughUi = true
  await stage('native-mcp-create')
  await ui(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  await ui(`window.openbot.agent.send(${JSON.stringify(sessionId)},'ROUTINE_TOOL_CREATE')`)
  await wait(`window.openbot.routines.list().then(rs=>rs.some(r=>r.name==='Tool once'&&r.lastRunState==='finished')&&rs.some(r=>r.name==='Tool folder'&&r.watchCursor))`)
  result.toolsRegisteredAndExecuted = true
  await stage('invalid-and-expired-once')
  const invalid = await ui(`window.openbot.routines.createInstruction(${JSON.stringify(botId)},'Invalid once','Must not run',{kind:'once',at:NaN},'quiet')`)
  assert.equal(invalid, null)
  const expired = await ui(`window.openbot.routines.createInstruction(${JSON.stringify(botId)},'Expired once','Must not run',{kind:'once',at:Date.now()-3600000},'quiet')`)
  await wait(`window.openbot.routines.get(${JSON.stringify(expired.id)}).then(r=>r.lastRunState==='missed'&&r.runs[0].startedAt===undefined)`)
  result.expiredMissedWithoutExecution = true
  const before = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(before.filter(item => item.tag === 'UI_ONCE_TOKEN').length, 1); assert.equal(before.filter(item => item.tag === 'TOOL_ONCE_TOKEN').length, 1)
  await stop(); await launch(); await delay(1800)
  await stage('restart-no-duplicate')
  const after = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(after.filter(item => item.tag === 'UI_ONCE_TOKEN').length, 1); assert.equal(after.filter(item => item.tag === 'TOOL_ONCE_TOKEN').length, 1)
  result.noDuplicateAfterNormalRestart = true
  result.ok = true
} catch (error) {
  result.error = String(error); result.failedStage = currentStage
  throw error
} finally {
  await stop().catch(error => { result.cleanupError = String(error); result.ok = false })
  await fs.writeFile(path.join(root, 'electron.log'), logs)
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ...result, evidence: path.join(root, 'result.json') }))
}
