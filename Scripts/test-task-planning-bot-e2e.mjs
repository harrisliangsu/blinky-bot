// Real native lead -> normal app chat -> model-selected MCP tools -> real stores.
// Only background workloads are controlled. No manual task mutations or routing.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'
import { connectPreview } from './fixtures/preview-debugger.mjs'
import { redactPrivateText } from '../src/main/backends/secretRedaction.ts'

const repo = process.cwd(), root = process.env.BLINKY_BOT_E2E_ROOT, kind = process.env.BLINKY_BOT_E2E_KIND || 'codex'
const executable = process.env.BLINKY_PLANNING_EXECUTABLE
assert.ok(root && executable && ['codex', 'kimi'].includes(kind))
assert.ok(!await fs.stat(root).catch(() => null), 'Use a fresh synthetic root')
const data = path.join(root, 'data'), work = path.join(root, 'work'), evidence = path.join(root, 'evidence'), control = path.join(root, 'control.json'), trace = path.join(root, 'worker.jsonl')
for (const dir of [data, work, evidence, ...['bots', 'sessions', 'tasks'].map(name => path.join(data, name))]) await fs.mkdir(dir, { recursive: true })
await fs.writeFile(control, '{}'); await fs.writeFile(trace, '')
const sourceHome = process.env.HOME, retainProfile = process.env.BLINKY_KEEP_TEST_PROFILE === '1', profile = retainProfile ? path.join(root, 'native-profile') : await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-planning-auth-'))
if (retainProfile) await fs.mkdir(profile, {mode:0o700})
await fs.chmod(profile, 0o700)
const sourceConfig = path.join(sourceHome, kind === 'codex' ? '.codex/config.toml' : '.kimi-code/config.toml')
const originals = [sourceConfig, ...(kind === 'codex' ? [path.join(sourceHome, '.codex/auth.json')] : [])]
const originalBytes = await Promise.all(originals.map(file => fs.readFile(file)))
let child, ui, main, logs = '', profileInfo, secrets = [], lastState, completed = []
const scrub = value => {
  let text = String(value); for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[redacted]')
  const safe = item => typeof item === 'string' ? redactPrivateText(item) : Array.isArray(item) ? item.map(safe) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, safe(val)])) : item
  try { return JSON.stringify(safe(JSON.parse(text)), null, 2) } catch { return redactPrivateText(text) }
}
const result = { kind, realLeadModel: true, controlledExecutor: true, manualTaskToolCalls: 0, root, stages: completed }
try {
  const selectedModel = kind === 'kimi' ? process.env.BLINKY_KIMI_MODEL : undefined
  profileInfo = JSON.parse(execFileSync('/opt/homebrew/bin/python3.11', ['Scripts/fixtures/prepare-planning-profile.py', '--kind', kind, '--dest', profile, '--source-home', sourceHome, ...(selectedModel ? ['--model', selectedModel] : []), ...(kind === 'codex' && process.env.BLINKY_TEST_AUTH_REFERENCE === '1' ? ['--reference-auth'] : [])], { cwd: repo, encoding: 'utf8' }))
  result.credentialMode = profileInfo.credentialMode
  result.credentialValuesCopied = profileInfo.credentialValuesCopied
  const config = await fs.readFile(path.join(profile, 'config.toml'), 'utf8')
  for (const match of config.matchAll(/"(?:api_key|apiKey)"\s*=\s*("(?:[^"\\]|\\.)*")/g)) secrets.push(JSON.parse(match[1]))
  if (kind === 'codex') {
    const auth = JSON.parse(await fs.readFile(path.join(profile, 'auth.json'), 'utf8'))
    const visit = value => { if (typeof value === 'string') secrets.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(visit) }; visit(auth)
  }
  const env = await connectionTestEnvironment(root)
  if (kind === 'codex') env.CODEX_HOME = profile
  else env.KIMI_CODE_HOME = profile
  if (kind === 'kimi') env.KIMI_DISABLE_TELEMETRY = '1'
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (process.env[name]) env[name] = process.env[name]
  Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data })
  const fixture = path.join(root, 'controlled-worker.cjs'), route = path.join(root, 'codex-route')
  await fs.writeFile(fixture, 'process.env.BLINKY_E2E_DATA=' + JSON.stringify(data) + ';process.env.BLINKY_E2E_CONTROL=' + JSON.stringify(control) + ';process.env.BLINKY_E2E_TRACE=' + JSON.stringify(trace) + ';\n' + await fs.readFile(path.join(repo, 'Scripts/fixtures/planning-e2e-worker.cjs'), 'utf8'))
  const realCodex = path.join(sourceHome, '.local/bin/codex')
  const proxySource = await fs.readFile(path.join(repo, 'Scripts/fixtures/planning-native-proxy.cjs'), 'utf8')
  const proxy = binary => '#!' + process.execPath + '\n' + 'globalThis.__planningNative=' + JSON.stringify({ binary, controlled: false, fixture, leadCwd: work, trace: path.join(root, 'native-protocol.jsonl') }) + ';\n' + proxySource
  const router = kind === 'codex' ? proxy(realCodex) : '#!' + process.execPath + '\nrequire(' + JSON.stringify(fixture) + ')\n'
  await fs.writeFile(route, router, { mode: 0o700 })
  const realKimi = path.join(sourceHome, '.kimi-code/bin/kimi')
  const kimiRoute = path.join(root, 'kimi-route')
  let kimiBinary = realKimi
  if (kind === 'kimi' && profileInfo.credentialMode === 'existing-api-key-environment-reference') {
    kimiBinary = path.join(root, 'kimi-env-launcher')
    const helper = path.join(repo, 'Scripts/fixtures/planning-kimi-env.py')
    const launcherArgs = [helper, '--source-config', sourceConfig, '--model', profileInfo.model, '--binary', realKimi,
      ...(process.env.BLINKY_GLM_NATIVE_NETWORK === '1' ? ['--node-preload', path.join(repo, 'Scripts/fixtures/glm-native-network.cjs'), '--network-trace', path.join(root, 'native-network.jsonl')] : []), '--']
    await fs.writeFile(kimiBinary, '#!/opt/homebrew/bin/python3.11\nimport runpy,sys\nsys.argv=' + JSON.stringify(launcherArgs) + '+sys.argv[1:]\nrunpy.run_path(' + JSON.stringify(helper) + ',run_name="__main__")\n', { mode: 0o700 })
  }
  if (kind === 'kimi') await fs.writeFile(kimiRoute, proxy(kimiBinary), { mode: 0o700 })
  const backends = Object.fromEntries(['codex','kimi','claude','claude-code','grok','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id => [id, { enabled: id === 'codex' || id === kind, command: id === 'codex' ? route : kimiRoute, extraArgs: [] }]))
  const leadModel = kind === 'kimi' && process.env.BLINKY_BOT_E2E_NATIVE_DEFAULT !== '1' ? profileInfo.model : 'default'
  result.configuredAppModel = leadModel
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'light', defaultBackendId: kind, defaultModelId: leadModel, memoryExtraction: 'off', notifications: false, notifyOnComplete: false, runRoutinesWhenClosed: false, localExecutionPolicy: 'always-allow', approvalPolicy: 'auto-run', backends }))
  const leadThinking = process.env.BLINKY_BOT_E2E_THINKING || (kind === 'codex' ? 'low' : undefined)
  result.configuredThinking = leadThinking
  const bot = { id: 'real-planner', name: 'Real planner ' + kind, description: 'Synthetic workflow verification', systemPrompt: '这是用户授权的隔离任务流验收。所有用户需求和执行产物都是合成数据，独立执行器只按控制信号输出占位文档；根据真实状态协调即可，不扩展成真实业务开发。普通实现决定自主处理。仅使用应用提供的任务工具，不调用原生 shell、读写文件、网络搜索、第三方 MCP 或其他外部工具。不要新建监控任务。', backendId: kind, modelId: leadModel, ...(leadThinking ? { thinking: leadThinking } : {}), executionAgent: { backendId: 'codex', modelId: 'fixture-worker' }, followsDefault: false, tools: ['delegate_task'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'planner-home', emoji: '🧪', color: '#888888', createdAt: 1, updatedAt: 1 }
  await fs.writeFile(path.join(data, 'bots', bot.id + '.json'), JSON.stringify(bot))
  await fs.writeFile(path.join(data, 'sessions', 'planner-home.json'), JSON.stringify({ id: 'planner-home', title: 'Synthetic requests', cwd: work, mode: 'agent', botIds: [bot.id], activeBotId: bot.id, messages: process.env.BLINKY_BOT_E2E_SEEDED_TASK === '1' ? [{id:'synthetic-communication-goal',role:'user',content:'验收内部沟通：执行者保持运行；Bot 到期询问实际进展与卡点，同一执行会话普通回复。仅合成数据，不外发。',createdAt:1}] : [], todos: [], archived: false, createdAt: 1, updatedAt: 1 }))
  const appPath = executable.slice(0, executable.indexOf('.app/') + 4), asar = path.join(appPath, 'Contents/Resources/app.asar')
  const chunks = (await fs.readdir(path.join(repo, 'out/main/chunks'))).filter(name => name.endsWith('.js'))
  for (const file of ['out/main/index.js', 'out/preload/index.cjs', ...chunks.map(name => 'out/main/chunks/' + name)]) assert.ok(extractFile(asar, file).equals(await fs.readFile(path.join(repo, file))))
  result.asarSha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
  result.configuredModel = profileInfo.model
  const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
  const port = await freePort(), mainPort = await freePort()
  child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--inspect=127.0.0.1:' + mainPort, '--user-data-dir=' + path.join(root, 'chromium')], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
  ui = await connectPreview(child, port, 'page', () => scrub(logs)); main = await connectPreview(child, mainPort, undefined, () => scrub(logs))
  await main.evaluate(`globalThis.__planningElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron')`)
  result.runtime = await main.evaluate(`({appPath:__planningElectron.app.getAppPath(),userData:__planningElectron.app.getPath('userData'),electron:process.versions.electron,pid:process.pid})`)
  assert.equal(result.runtime.userData, data)
  await ui.evaluate(`(()=>{window.__planningEvents=[];window.openbot.on(event=>{window.__planningEvents.push(event);if(event.type==='approval-request'){const r=event.request;const safe=r.kind==='mcp'&&/(?:^|[^a-zA-Z0-9])(?:manage_task|delegate_task|review_task)(?:$|[^a-zA-Z0-9])/.test(r.summary)&&!/(?:恢复任务|Action:\\s*(?:stop|resume)|"action"\\s*:\\s*"(?:stop|resume)")/.test(r.detail+' '+r.summary);window.openbot.agent.respondToApproval(r.id,safe?'approve':'reject')}})})()`)
  const state = async () => lastState = await ui.evaluate(`Promise.all([window.openbot.tasks.list(),window.openbot.sessions.get('planner-home'),window.openbot.agent.isRunning('planner-home')]).then(([tasks,session,running])=>({tasks,session,running,events:window.__planningEvents}))`)
  const stageBudgetMs = Number(process.env.BLINKY_BOT_E2E_STAGE_MS || 180000)
  assert.ok(stageBudgetMs >= 1000 && stageBudgetMs <= 360000)
  result.stageBudgetMs = stageBudgetMs
  const until = async (fn, ms = stageBudgetMs) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(180) } throw new Error('E2E condition timed out; inspect state.json') }
  // Supervised CLI tool calls are app events, not message.toolCalls. Preserve
  // the real gateway observations rather than inferring a call from prose.
  const calls = events => events.filter(event => event.type === 'tool-call' && event.sessionId === 'planner-home').map(event => event.call)
  const ask = async (id, text) => {
    await fs.writeFile(path.join(evidence, id + '-started.json'), JSON.stringify({id,text,at:Date.now(),budgetMs:stageBudgetMs}))
    console.log(JSON.stringify({stage:id,state:'started'}))
    const stageStartedAt=Date.now()
    await until(async () => !(await state()).running)
    const before = await state(), messageIds = new Set(before.session.messages.map(message => message.id))
    assert.equal(await ui.evaluate(`window.openbot.agent.send('planner-home',${JSON.stringify(text)})`), true)
    await until(async () => {
      const now = await state()
      return !now.running && now.session.messages.some(message => !messageIds.has(message.id) && message.role === 'assistant' && !message.internal && !message.uiOnly && !message.streaming && (message.content || message.error))
    })
    const now = await state(), newMessages = now.session.messages.filter(message => !messageIds.has(message.id))
    const stage = { id, durationMs: Date.now()-stageStartedAt, request: text, messages: newMessages, calls: calls(now.events.slice(before.events.length)), tasks: now.tasks }
    console.log(JSON.stringify({stage:id,state:'returned',durationMs:stage.durationMs,calls:stage.calls.length}))
    completed.push(stage); await fs.writeFile(path.join(evidence, id + '.json'), scrub(JSON.stringify(stage, null, 2)))
    assert.ok(!newMessages.some(message => message.error), scrub(JSON.stringify(newMessages.filter(message => message.error))))
    return now.tasks
  }
  const allFiles = async () => {
    const files = await fs.readdir(path.join(data, 'tasks'))
    return Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(data, 'tasks', name), 'utf8'))))
  }
  const release = async id => { const values = JSON.parse(await fs.readFile(control, 'utf8')); values[id] = true; await fs.writeFile(control, JSON.stringify(values)) }
  if (process.env.BLINKY_BOT_E2E_READINESS_ONLY === '1') {
    result.readinessRecheck = await ui.evaluate(`window.openbot.backends.recheck('kimi').then(rows=>rows.filter(row=>row.id==='kimi').map(row=>({id:row.id,status:row.status,cliAuth:row.cliAuth})))`)
    assert.equal(result.readinessRecheck[0]?.status, 'available')
    assert.equal(result.readinessRecheck[0]?.cliAuth?.account, 'API key configuration')
    result.variant = 'native-configuration-readiness-only'
    result.actualToolCalls = []
    result.persistedTasks = await allFiles()
    result.checks = ['real-native-provider-configuration-projection', 'api-key-without-oauth-ready', 'no-model-request-or-task-dispatched']
  } else if (process.env.BLINKY_BOT_E2E_COMMUNICATION === '1') {
    const seeded=process.env.BLINKY_BOT_E2E_SEEDED_TASK==='1'
    const tasks = seeded ? [await ui.evaluate(`window.openbot.tasks.create('real-planner','合成执行器保持运行，接收 Bot 到期询问并在同一执行会话普通回复。只验证沟通传递与归属，不外发。','合成沟通验收')`)] : await ask('new-owned-task','安排一个合成验收任务：执行者先保持运行等待，Bot 定期询问真实进展、卡点与调整，再由同一执行会话普通回复。只验传递与归属，不外发或改真实文件。')
    result.modelSelectedTaskCreation=!seeded;result.manualTaskCreations=seeded?1:0
    assert.equal(tasks.length,1)
    const first=tasks[0],coordPath=path.join(data,'task-coordination',first.id+'.json'),receiptPath=path.join(data,'task-messages',first.id+'.json')
    result.newTaskContextSupplied=Boolean(first.plan?.context?.summary)
    const coordination=async()=>JSON.parse(await fs.readFile(coordPath,'utf8').catch(()=> 'null'))
    await until(async()=>Boolean(await coordination()),30000)
    await until(async()=>!(await state()).running)
    const before=await coordination();before.nextCheckAt=Date.now()-1;await fs.writeFile(coordPath,JSON.stringify(before))
    await ui.evaluate(`window.openbot.sessions.setCwd('planner-home',${JSON.stringify(work)})`)
    let receipt
    await until(async()=>{
      const value=JSON.parse(await fs.readFile(receiptPath,'utf8').catch(()=>'{"messages":[]}'))
      receipt=value.messages.find(m=>m.direction==='to_executor'&&m.requestId.startsWith('bot-coordinate:')&&['queued','delivering','delivered'].includes(m.status))
      return Boolean(receipt)
    },180000)
    result.inquiry={requestId:receipt.requestId,status:receipt.status,delivery:receipt.delivery,text:receipt.text}
    result.realOwningJudgment=true
    result.protectedJudgment=JSON.parse(await fs.readFile(path.join(data,'task-judgments',first.id+'.json'),'utf8'))
    assert.equal(result.protectedJudgment.state,'ready')
    assert.equal((await allFiles()).length,1)
    const beforeRelease=await allFiles();assert.equal(beforeRelease[0].sessionId,first.sessionId)
    await release(first.id)
    await until(async()=>{
      const rows=JSON.parse(await fs.readFile(receiptPath,'utf8')).messages
      receipt=rows.find(m=>m.requestId===result.inquiry.requestId)
      return receipt?.status==='delivered'&&receipt.responseMessageIds?.length
    })
    result.correlatedResponse=receipt
    const execution=await ui.evaluate(`window.openbot.sessions.get(${JSON.stringify(first.sessionId)})`)
    result.responseMessages=execution.messages.filter(m=>receipt.responseMessageIds.includes(m.id))
    assert.ok(result.responseMessages.some(m=>m.content.trim()))
    await ask('ordinary-followup','只用一句自然中文确认主聊天仍可对话，不调用工具，不创建任务，不要JSON。')
    result.variant='real-owning-kimi-protected-inquiry-controlled-executor'
    result.actualToolCalls=calls((await state()).events)
    result.persistedTasks=await allFiles()
    result.checks=[seeded?'synthetic-ipc-created-task':'normal-user-created-task','real-owning-kimi-protected-decision','due-checkpoint-inquiry-through-existing-task-channel','single-original-execution-session','safe-boundary-delivery-and-exact-response-ids','normal-human-followup-after-private-judgment']
    result.limits=['controlled execution workload, not real Kimi executor','checkpoint advanced, not a long-duration cadence measurement','reply correlation is not independent advice-adoption proof']
  } else if (process.env.BLINKY_BOT_E2E_SMOKE === '1') {
    const tasks = await ask('runtime-smoke', '只回复 KIMI_RUNTIME_OK，不使用任何工具，不派发任务。')
    assert.equal(tasks.length, 0)
    assert.match(completed.at(-1).messages.filter(message => message.role === 'assistant').map(message => message.content).join(''), /KIMI_RUNTIME_OK/)
    result.variant = 'runtime-readiness-smoke'
    result.actualToolCalls = calls((await state()).events)
    result.persistedTasks = await allFiles()
    result.checks = ['normal-user-chat-entry', 'real-native-model-public-reply', 'no-task-dispatched']
  } else {
    let tasks = await ask('new', '帮我安排 Alpha 项目的 CSV 导出说明：先分析字段和时区约束，再写一份说明并核对样例，范围 src/export。这里只验任务流，执行阶段生成合成占位文档即可，保留独立成果交付。')
    assert.equal(tasks.length, 1); const first = tasks[0]
    assert.ok(first.plan?.context?.summary && first.plan.context.categories.length)
    await until(async () => (await fs.readFile(trace, 'utf8')).includes(first.id))
    tasks = await ask('supplement', '刚才 Alpha 的 CSV 说明再补一个上海时区示例，其他目标和修改范围保留。')
    assert.equal(tasks.length, 1)
    const messageFile = JSON.parse(await fs.readFile(path.join(data, 'task-messages', first.id + '.json'), 'utf8'))
    assert.ok(messageFile.messages.some(message => message.direction === 'to_executor' && ['queued', 'delivered'].includes(message.status) && /上海/.test(message.text)))
    tasks = await ask('independent', '另外安排 Beta 项目的 PDF 导出说明，同样分分析、编写和核对三个步骤。工程范围 src/pdf，与 Alpha 的 CSV 没有输入依赖；本次也只生成合成占位文档。')
    assert.equal(tasks.length, 2); const other = tasks.find(task => task.id !== first.id)
    await until(async () => (await allFiles()).filter(task => task.workspace?.path).length === 2)
    let saved = await allFiles()
    assert.notEqual(saved.find(task => task.id === first.id).workspace.path, saved.find(task => task.id === other.id).workspace.path)
    tasks = await ask('dependency', 'Alpha 交付再加一份独立的 JSON 转换说明，单独交付，占位文档即可。它的唯一输入是那份 CSV 说明，必须等 CSV 返回后才能做；消费 CSV 原有成果目录，范围 src/convert。CSV 的字段和时区说明仍归原执行者，不要重复。')
    assert.equal(tasks.length, 3); const dependent = tasks.find(task => ![first.id, other.id].includes(task.id))
    assert.ok(dependent.plan.dependencies.includes(first.id)); assert.equal(dependent.status, 'queued')
    await release(first.id)
    await until(async () => { const ts = await allFiles(); return ts.find(t => t.id === first.id)?.status === 'completed' && ts.find(t => t.id === dependent.id)?.status === 'running' })
    tasks = await ask('continuation-conflict', 'Alpha 那份 CSV 说明已有结果，再补完原来的时区验收，接着上一轮做，文件和上下文都保留。转换说明的工作不能中断；如果成果目录被占用，让这次补验收等它结束再执行。仍只生成合成占位结果。')
    const continued = tasks.find(task => task.continuedFromTaskId === first.id)
    assert.ok(continued, 'The real Bot must request the same-task continuation')
    assert.equal(continued.sessionId, first.sessionId)
    assert.equal(continued.status, 'queued')
    saved = await allFiles()
    assert.equal(saved.find(task => task.id === dependent.id).status, 'running')
    assert.equal(saved.find(task => task.id === continued.id).workspace.path, saved.find(task => task.id === first.id).workspace.path)
    await release(dependent.id)
    await until(async () => (await allFiles()).find(task => task.id === continued.id)?.status === 'running')
    await release(continued.id)
    await until(async () => (await allFiles()).find(task => task.id === continued.id)?.status === 'completed')
    await until(async () => !(await state()).running)
    const final = await state()
    assert.equal(final.tasks.find(task => task.id === other.id).status, 'running')
    assert.ok(!final.tasks.some(task => task.status === 'cancelled'))
    const actualCalls = calls(final.events)
    assert.ok(actualCalls.some(call => call.name === 'manage_task' && call.args.action === 'match'))
    assert.ok(actualCalls.some(call => call.name === 'manage_task' && call.args.action === 'message'))
    assert.ok(actualCalls.some(call => call.name === 'delegate_task' && call.args.continue_task_id === first.id))
    result.actualToolCalls = actualCalls
    result.persistedTasks = await allFiles()
    result.receipts = JSON.parse(await fs.readFile(path.join(data, 'task-messages', first.id + '.json'), 'utf8'))
    result.workerTrace = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const originalResult=result.workerTrace.find(row=>row.method==='finish'&&row.taskId===first.id&&row.status==='completed')
    assert.ok(originalResult)
    const produced=await fs.readFile(originalResult.file,'utf8')
    assert.match(produced,/上海/,'The original worker output must actually contain the delivered Shanghai supplement')
    result.diskReadback={originalResult:originalResult.file,containsSupplement:true,taskFiles:result.persistedTasks.map(t=>({id:t.id,sessionId:t.sessionId,status:t.status,context:t.plan?.context,dependencies:t.plan?.dependencies,workspace:t.workspace}))}


    result.checks = ['normal-user-chat-entry','real-native-bot-selected-tools','descriptions-and-categories-persisted','active-supplement-receipt','independent-goal-separate-workspace','real-dependency-queued-and-released','same-session-continuation','shared-workspace-conflict-serialized','unrelated-executor-preserved','no-existing-task-cancelled','worker-file-contains-real-delivered-supplement']
  }
  if (kind === 'kimi') {
    result.backendReadiness = await ui.evaluate(`window.openbot.backends.list().then(rows=>rows.filter(row=>row.id==='kimi').map(row=>({id:row.id,status:row.status,cliAuth:row.cliAuth})))`)
    assert.equal(result.backendReadiness[0]?.status, 'available', 'Configured Kimi identity must remain usable after async readiness refresh')
  }
  result.ok = true
  const screenshot = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, 'preview.png'), Buffer.from(screenshot.data, 'base64'))
} catch (error) { result.ok = false; result.error = scrub(error.stack); process.exitCode = 1 }
finally {
  if (ui) {
    try { lastState = await ui.evaluate(`Promise.all([window.openbot.tasks.list(),window.openbot.sessions.get('planner-home'),window.openbot.agent.isRunning('planner-home')]).then(([tasks,session,running])=>({tasks,session,running,events:window.__planningEvents}))`) } catch {}
  }
  if (main) await main.evaluate('__planningElectron.app.quit()').catch(() => {})
  ui?.close(); main?.close()
  if (child && child.exitCode === null && child.signalCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
  result.exitCode=child?.exitCode;result.signal=child?.signalCode
  result.sourceConfigurationUnchanged = (await Promise.all(originals.map((file, index) => fs.readFile(file).then(bytes => bytes.equals(originalBytes[index]))))).every(Boolean)
  try { if (!retainProfile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 }) }
  catch (error) { result.cleanupError = error.code; result.ok = false; process.exitCode = 1 }
  result.retainedProfileReference = retainProfile ? profile : undefined
  result.temporaryProfileRemoved = !await fs.stat(profile).catch(() => null)
  await fs.writeFile(path.join(evidence, 'result.json'), scrub(JSON.stringify(result, null, 2)))
  if (lastState) await fs.writeFile(path.join(evidence, 'state.json'), scrub(JSON.stringify(lastState, null, 2)))
  await fs.writeFile(path.join(evidence, 'electron.log'), scrub(logs))
  console.log(JSON.stringify({ ok: result.ok, kind, stages: completed.map(value => value.id), result: path.join(evidence, 'result.json'), error: result.error }))
}
