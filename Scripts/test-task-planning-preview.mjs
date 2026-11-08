// Real mounted Preview, MCP gateway, registry, IPC and persistence.
// Only executor output is controlled. A separate run covers real model semantics.
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'

const repo = process.cwd(), root = process.env.BLINKY_PLANNING_TEST_ROOT
const executable = process.env.BLINKY_PLANNING_EXECUTABLE
assert.ok(root && executable?.startsWith('/'), 'Set the isolated root and mounted Preview executable')
assert.ok(executable.includes('/BlinkyBot Preview.app/'))
const data = path.join(root, 'data'), work = path.join(root, 'work'), control = path.join(root, 'control.json'), evidence = path.join(root, 'evidence')
for (const dir of [data, work, evidence, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(dir, { recursive: true })
await fs.writeFile(control, '{}')
const fake = path.join(root, 'fixture-codex')
let fixtureCode = await fs.readFile(path.join(repo, 'Scripts/fixtures/task-planning-codex.cjs'), 'utf8')
if (process.env.BLINKY_CANDIDATE_INTEGRATION === '1') {
 fixtureCode = fixtureCode.replace("'Controlled executor returned ' + item.tag", "item.tag === 'JUDGMENT' ? JSON.stringify({kind:'silent'}) : 'Controlled executor returned ' + item.tag").replace("const tag = (input.match(/TEST_WORK_([A-Z]+)/) || [null, 'LEAD'])[1]", "const tag = input.includes('INTEGRATION_JUDGMENT') ? 'JUDGMENT' : (input.match(/TEST_WORK_([A-Z]+)/) || [null, 'LEAD'])[1]").replace("if (p.model !== 'fixture-worker')", "if (tag !== 'JUDGMENT' && p.model !== 'fixture-worker')")
}
await fs.writeFile(fake, '#!' + process.execPath + '\nprocess.env.BLINKY_PLANNING_CONTROL=' + JSON.stringify(control) + ';\n' + fixtureCode, { mode: 0o700 })
const env = await connectionTestEnvironment(root)
Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, BLINKY_PLANNING_CONTROL: control })
const backends = Object.fromEntries(['codex', 'claude', 'claude-code', 'kimi', 'grok', 'pi', 'droid', 'opencode', 'openai', 'anthropic', 'openrouter', 'xai'].map(id => [id, { enabled: id === 'codex', command: fake, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'fixture-lead', memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false, approvalPolicy: 'auto-run', localExecutionPolicy: 'always-allow', backends }))
const bot = { id: 'planning-bot', name: 'Planning test', emoji: '🧪', color: '#888888', description: 'Isolated synthetic planning', systemPrompt: 'Controlled test', backendId: 'codex', modelId: 'fixture-lead', followsDefault: false, executionAgent: { backendId: 'codex', modelId: 'fixture-worker' }, tools: ['delegate_task'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'planning-home', createdAt: 1, updatedAt: 1 }
await fs.writeFile(path.join(data, 'bots', bot.id + '.json'), JSON.stringify(bot))
await fs.writeFile(path.join(data, 'sessions', 'planning-home.json'), JSON.stringify({ id: 'planning-home', cwd: work, mode: 'agent', botIds: [bot.id], activeBotId: bot.id, messages: process.env.BLINKY_CANDIDATE_INTEGRATION === '1' ? [{id:'integration-visible-goal',role:'user',content:'规划与沟通整合验收：原始用户目标应持续可见。',createdAt:1},...Array.from({length:205},(_,i)=>({id:'agent-judgment-old-'+i,role:'assistant',content:'PRIVATE_INTEGRATION_'+i,internal:true,createdAt:2+i}))] : [], todos: [], archived: false, createdAt: 1, updatedAt: 1 }))
const appPath = executable.slice(0, executable.indexOf('.app/') + 4), asar = path.join(appPath, 'Contents/Resources/app.asar')
const asarSha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
assert.equal(asarSha256, process.env.EXPECTED_ASAR_SHA)
assert.equal(JSON.parse(extractFile(asar, 'package.json')).blinkyBuildChannel, 'preview')
const chunks = await fs.readdir(path.join(repo, 'out/main/chunks'))
const buildFiles = ['out/main/index.js', 'out/preload/index.cjs', ...chunks.filter(name => name.endsWith('.js')).map(name => 'out/main/chunks/' + name)]
for (const file of buildFiles) assert.ok(extractFile(asar, file).equals(await fs.readFile(path.join(repo, file))), 'Mounted package differs from the local final build: ' + file)
const gatewayChunk = (await Promise.all(chunks.map(async name => ({ name, text: await fs.readFile(path.join(repo, 'out/main/chunks', name), 'utf8') })))).find(value => /export \{[\s\S]*\battachSession,/.test(value.text))?.name
assert.ok(gatewayChunk)
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const port = await freePort(), mainPort = await freePort()
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--inspect=127.0.0.1:' + mainPort, '--user-data-dir=' + path.join(root, 'chromium')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
let main, ui, grant, rpcSession, rpcSequence = 0
const result = { executable, asarSha256, buildFilesVerified: buildFiles, realElectron: true, realMcpGateway: true, controlledExecutor: true, realModel: false }
async function until(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(70) } throw new Error('Planning state timed out: ' + logs.slice(-1800)) }
async function rpc(method, params) {
  const response = await fetch(grant.url, { method: 'POST', headers: { Authorization: 'Bearer ' + grant.bearerToken, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(rpcSession ? { 'Mcp-Session-Id': rpcSession } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method, params }) })
  rpcSession = response.headers.get('mcp-session-id') ?? rpcSession
  const text = await response.text()
  const packet = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data:')).slice(5) : text)
  if (packet.error) throw new Error(JSON.stringify(packet.error))
  return packet.result
}
async function tool(name, args, errorExpected = false) {
  const value = await rpc('tools/call', { name, arguments: args })
  const output = value.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  if (errorExpected) { assert.equal(value.isError, true); return output }
  assert.ok(!value.isError, output)
  const wrapper = output.match(/<tool_result_data>\s*([\s\S]*?)\s*<\/tool_result_data>/)
  const body = wrapper ? JSON.parse(wrapper[1]).output : output
  try { return JSON.parse(body) } catch { return body }
}
const tasks = () => ui.evaluate('window.openbot.tasks.list()')
const task = async id => (await tasks()).find(value => value.id === id)
const context = (summary, scope, extra = {}) => ({ summary, categories: ['开发'], scope, boundaries: ['只使用隔离测试数据'], ...extra })
const delegate = async (tag, ctx, plan = {}, previous) => {
  const response = await tool('delegate_task', { prompt: 'Controlled TEST_WORK_' + tag, title: '相同标题', ...(previous ? { continue_task_id: previous } : {}), plan: { ...plan, ...(ctx ? { context: ctx } : {}) } })
  const id = response.match(/Task ID: ([a-z0-9-]+)/)?.[1]
  assert.ok(id, response); return id
}
try {
  ui = await connect(port, 'page'); main = await connect(mainPort)
  await ui.send('Runtime.enable')
  await until(() => ui.evaluate('Boolean(window.openbot && document.querySelector("#ob-prompt"))'))
  await main.evaluate(`(()=>{const require=process.getBuiltinModule('module').createRequire(process.execPath);globalThis.__planningElectron=require('electron');globalThis.__planningGateway=require(__planningElectron.app.getAppPath()+'/out/main/chunks/'+${JSON.stringify(gatewayChunk)})})()`)
  result.runtime = await main.evaluate(`({electron:process.versions.electron,appPath:__planningElectron.app.getAppPath(),userData:__planningElectron.app.getPath('userData'),pid:process.pid})`)
  assert.equal(result.runtime.appPath, path.join(appPath, 'Contents/Resources/app.asar'))
  assert.equal(result.runtime.userData, data)
  grant = await main.evaluate(`__planningGateway.attachSession({sessionId:'planning-home',botId:'planning-bot',cwd:${JSON.stringify(work)},backendId:'codex'})`)
  await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'planning-verification', version: '1' }, capabilities: {} })
  const schemas = (await rpc('tools/list', {})).tools
  assert.ok(schemas.find(value => value.name === 'manage_task').inputSchema.properties.action.enum.includes('match'))
  assert.ok(schemas.find(value => value.name === 'delegate_task').inputSchema.properties.plan.properties.context)
  if (process.env.BLINKY_CANDIDATE_INTEGRATION === '1') {
    await ui.evaluate(`window.__integrationApprovals=[];window.openbot.on(e=>{if(e.type==='approval-request')window.__integrationApprovals.push(e.request)})`)
    for (const action of ['describe', 'message']) {
      await ui.evaluate(`window.openbot.settings.update({asklist:[${JSON.stringify(action)}]})`)
      const pending = tool('manage_task', {action,task_id:'not-created',text:'Synthetic rejected supplement',request_id:'rejected-'+action,...(action==='describe'?{context:context('should never persist',['src/rejected'])}:{})}, true)
      const card = await until(()=>ui.evaluate(`window.__integrationApprovals.find(r=>r.toolName==='manage_task'&&r.detail.includes(${JSON.stringify(action)}))`))
      assert.equal(card.sessionId,'planning-home')
      await ui.evaluate(`window.openbot.agent.respondToApproval(${JSON.stringify(card.id)},'reject')`)
      assert.match(await pending,/Not approved/)
    }
    await ui.evaluate(`window.openbot.settings.update({asklist:[]})`)
  }
  const one = await delegate('EXPORT', context('项目甲测试环境导出CSV', ['project-a/test', 'src/export']))
  const two = await delegate('PDF', context('项目乙正式环境导出PDF', ['project-b/prod', 'src/pdf']))
  await until(async () => (await task(one))?.status === 'running' && (await task(two))?.status === 'running')
  let facts = await tool('manage_task', { action: 'match', text: '项目甲CSV追加时区', context: context('追加时区', ['src/export/timezone.ts']) })
  assert.equal(facts.total, 2)
  assert.deepEqual(facts.candidates.find(value => value.id === one).scopeOverlap, ['src/export/timezone.ts'])
  assert.deepEqual(facts.candidates.find(value => value.id === two).scopeOverlap, [])
  await tool('manage_task', { action: 'describe', task_id: one, context: context('项目甲CSV支持时区 password=synthetic-private-value', ['src/export/timezone.ts']) })
  assert.ok(!(await fs.readFile(path.join(data, 'tasks', one + '.json'), 'utf8')).includes('synthetic-private-value'))
  const firstSession = (await task(one)).sessionId
  if (process.env.BLINKY_CANDIDATE_INTEGRATION === '1') {
    await until(() => ui.evaluate(`window.openbot.agent.liveMessages(${JSON.stringify(firstSession)}).then(messages=>messages.some(message=>(message.content||'').includes('is running EXPORT')))`))
    const stored = await ui.evaluate(`window.openbot.sessions.get(${JSON.stringify(firstSession)})`)
    assert.ok(stored.messages.some(m => m.role === 'user' && m.content.includes('Task scope observations') && m.content.includes('Internal progress protocol')), 'Both candidate prompt contracts must reach the same executor')
    const inspect = await tool('manage_task', {action:'inspect',task_id:one})
    assert.ok(inspect.executionEvidence && Object.hasOwn(inspect,'automaticJudgment') && inspect.task.plan.context)
    await main.evaluate(`(()=>{const req=process.getBuiltinModule('module').createRequire(process.execPath),fs=process.getBuiltinModule('fs'),dir=__planningElectron.app.getAppPath()+'/out/main/chunks',file=fs.readdirSync(dir).find(n=>n.endsWith('.js')&&fs.readFileSync(dir+'/'+n,'utf8').includes('async function protectedProgressDecision('));const m=req(dir+'/'+file);globalThis.__integrationApi=Object.fromEntries(['protectedProgressDecision','progressSnapshot','getTask','taskJudgmentAllows'].map(n=>[n,Object.values(m).find(v=>typeof v==='function'&&v.name===n)]));globalThis.__integrationDecision=__integrationApi.protectedProgressDecision(__integrationApi.progressSnapshot(__integrationApi.getTask(${JSON.stringify(one)})),{sessionId:'planning-home',botId:'planning-bot',prompt:'INTEGRATION_JUDGMENT Return only JSON: {"kind":"silent"}. No tools.',permissions:'integration-only',signal:new AbortController().signal});return true})()`)
    await until(()=>main.evaluate(`!__integrationApi.taskJudgmentAllows('planning-home','manage_task',{action:'describe',task_id:${JSON.stringify(one)}})`))
    grant = await main.evaluate(`__planningGateway.attachSession({sessionId:'planning-home',botId:'planning-bot',cwd:${JSON.stringify(work)},backendId:'codex'})`);rpcSession=undefined
    await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'private-scope-test',version:'1'},capabilities:{}})
    assert.deepEqual((await rpc('tools/list',{})).tools,[])
    for (const action of ['describe','message','resume']) assert.match(await tool('manage_task',{action,task_id:one},true),/Internal task consideration/)
    const delegated = await rpc('tools/call',{name:'delegate_task',arguments:{prompt:'Must not start'}})
    assert.equal(delegated.isError,true)
    assert.equal((await tasks()).length,2)
    await fs.writeFile(control,JSON.stringify({JUDGMENT:true}))
    const decision=await main.evaluate('globalThis.__integrationDecision')
    assert.equal(decision,null,'An attempted forbidden action invalidates the private decision')
    grant = await main.evaluate(`__planningGateway.attachSession({sessionId:'planning-home',botId:'planning-bot',cwd:${JSON.stringify(work)},backendId:'codex'})`);rpcSession=undefined
    await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'restored-normal-test',version:'1'},capabilities:{}})
    assert.ok((await rpc('tools/list',{})).tools.some(t=>t.name==='delegate_task'))
    assert.ok((await tool('manage_task',{action:'match',text:'正常规划恢复'})).candidates.length===2)
    result.integrationChecks=['combined-planning-and-progress-in-execution-input','combined-inspection-fields','actual-mcp-description-and-message-approval-rejected-before-write','same-bot-judgment-with-empty-app-grant','actual-protected-mcp-mutation-and-delegation-refused','no-extra-executor-started','private-decision-settled-and-normal-planning-restored']
  }

  await until(() => ui.evaluate(`window.openbot.agent.liveMessages(${JSON.stringify(firstSession)}).then(messages=>messages.some(message=>(message.content||'').includes('is running EXPORT')))`))
  const active = await tool('manage_task', { action: 'message', task_id: one, text: '追加时区范围，保留原目标', request_id: 'preview-timezone' })
  assert.equal(active.receipt.status, 'delivered')
  assert.equal(active.receipt.delivery, 'live')
  assert.equal((await task(one)).status, 'running')
  const duplicate = await tool('manage_task', { action: 'message', task_id: one, text: '追加时区范围，保留原目标', request_id: 'preview-timezone' })
  assert.equal(duplicate.duplicate, true)
  const dependent = await delegate('INTEGRATE', context('集成CSV，PDF仍归另一执行者', ['src/export'], { parent_task_id: two }), { depends_on: [one] })
  assert.equal((await task(dependent)).status, 'queued')
  facts = await tool('manage_task', { action: 'match', text: '核对依赖与范围' })
  assert.deepEqual(facts.candidates.find(value => value.id === dependent).scheduling.waiting, [one])
  await fs.writeFile(control, JSON.stringify({ EXPORT: true }))
  await until(async () => (await task(one))?.status === 'completed' && (await task(dependent))?.status === 'running')
  const continued = await delegate('EXPORT', undefined, {}, one)
  assert.equal((await task(continued)).status, 'queued', 'The dependent task still owns the shared output directory')
  facts = await tool('manage_task', { action: 'match', text: '检查共享工作区冲突' })
  assert.ok(facts.candidates.find(value => value.id === continued).sharesWorkspaceWith.includes(dependent))
  await fs.writeFile(control, JSON.stringify({ EXPORT: true, INTEGRATE: true }))
  await until(async () => (await task(continued))?.status === 'completed')
  assert.equal((await task(continued)).sessionId, (await task(one)).sessionId)
  assert.equal((await task(continued)).workspace.path, (await task(one)).workspace.path)
  assert.equal((await task(continued)).plan.context.summary, (await task(one)).plan.context.summary)
  assert.equal((await task(two)).status, 'running')
  assert.equal((await task(dependent)).plan.context.parentTaskId, two)
  assert.match(await tool('manage_task', { action: 'message', task_id: continued, text: 'too late', request_id: 'returned-no-message' }, true), /returned/)
  facts = await tool('manage_task', { action: 'match', text: '检查最新续接' })
  assert.ok(!facts.candidates.some(value => value.id === one))
  assert.ok(facts.candidates.some(value => value.id === continued))
  result.checks = ['mounted-asar-bound-to-build', 'tool-schema-through-real-mcp', 'same-title-different-goal-and-scope', 'description-durable-and-private', 'live-supplement-and-idempotency', 'dependency-waits-and-releases', 'parent-scope-without-implied-dependency', 'shared-workspace-conflict-queues-continuation', 'returned-continuation-same-session-and-files', 'latest-attempt-matching', 'returned-message-rejected', 'other-executor-keeps-running']
  if (process.env.BLINKY_CANDIDATE_INTEGRATION === '1') {
    await ui.evaluate(`window.openbot.settings.update({asklist:['tool:synthetic-revocation']})`)
    await until(async()=> (await task(two))?.status === 'cancelled')
    result.integrationChecks.push('live-permission-revocation-is-cancellation-not-completion')
    await ui.evaluate(`document.querySelector('.ob-side-item-main[aria-label="Planning test"]')?.click()`)
    await until(()=>ui.evaluate(`(document.querySelector('.ob-transcript')?.innerText||'').includes('规划与沟通整合验收')`))
    const transcript = await ui.evaluate(`document.querySelector('.ob-transcript').innerText`)
    assert.ok(!transcript.includes('PRIVATE_INTEGRATION_'))
    const history = await ui.evaluate(`window.openbot.sessions.get('planning-home')`)
    assert.ok(history.messages.filter(m=>m.id.startsWith('agent-judgment-old-')).length===205)
    result.integrationChecks.push('205-private-records-preserved-with-original-goal-visible')
    result.ui=[]
    for(const [theme,width,height] of [['light',1120,760],['dark',680,660]]) {
      await ui.evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`)
      await main.evaluate(`__planningElectron.BrowserWindow.getAllWindows()[0].setSize(${width},${height})`)
      await delay(250)
      const state=await ui.evaluate(`({theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,visible:(document.querySelector('.ob-transcript')?.innerText||'').includes('规划与沟通整合验收'),canType:!!document.querySelector('#ob-prompt')&&!document.querySelector('#ob-prompt').disabled,horizontalOverflow:document.documentElement.scrollWidth>innerWidth})`)
      assert.equal(state.visible,true);assert.equal(state.canType,true);assert.equal(state.horizontalOverflow,false)
      const shot=await ui.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'integrated-'+theme+'.png'),Buffer.from(shot.data,'base64'));result.ui.push(state)
    }
  }
  const shot = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, 'preview.png'), Buffer.from(shot.data, 'base64'))
  assert.deepEqual(rendererErrors, [])
  result.rendererErrors = rendererErrors; result.ok = true
} catch (error) { result.ok = false; result.error = error.stack; result.failedTasks = await tasks().catch(()=>[]); throw error }
finally {
  if (main) await main.evaluate('__planningElectron.app.quit()').catch(() => {})
  for (const ws of sockets) ws.close()
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  result.exitCode=child.exitCode;result.signal=child.signalCode
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(path.join(evidence, 'electron.log'), logs)
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks?.length, root, result: path.join(evidence, 'result.json') }))
}
