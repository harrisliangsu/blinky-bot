/** Mounted Preview + actual UI/IPC/store/tools; model service and encryption are synthetic. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'
import { connectInspector } from './inspect-installed-app.mjs'

const executable = process.env.BLINKY_UNIFIED_EXECUTABLE
assert.equal(process.platform, 'darwin', 'macOS Electron is required')
assert.ok(executable?.startsWith('/Volumes/'), 'Use the coordinator-frozen, read-only mounted Preview')
const bundle = executable.slice(0, executable.indexOf('.app/') + 4), asar = path.join(bundle, 'Contents/Resources/app.asar')
assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).blinkyBuildChannel, 'preview')
const sha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
assert.match(process.env.EXPECTED_ASAR_SHA ?? '', /^[a-f0-9]{64}$/)
assert.equal(sha256, process.env.EXPECTED_ASAR_SHA, 'Bind this run to the frozen ASAR')
const root = process.env.BLINKY_ROUTING_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-unified-memory-routing-'))
if (process.env.BLINKY_ROUTING_ROOT) await fs.mkdir(root, { recursive: false })
const routingOnly = process.env.BLINKY_ROUTING_ONLY === '1'
const uiOnly = process.env.BLINKY_ROUTING_UI_ONLY === '1'
const data = path.join(root, 'data'), evidence = process.env.EVIDENCE_DIR ?? path.join(root, 'evidence')
await Promise.all(['bots','sessions','memory','tasks'].map(name => fs.mkdir(path.join(data, name), { recursive: true })))
await fs.mkdir(evidence, { recursive: true })
const env = await connectionTestEnvironment(root)
Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', KIMI_CODE_HOME: path.join(root, 'home', '.kimi-code'), GROK_HOME: path.join(root, 'home', '.grok'), PI_CODING_AGENT_DIR: path.join(root, 'home', '.pi', 'agent') })
const botId = 'unified-memory-bot', sessionId = 'unified-memory-home', hiddenTaskId = 'unified-hidden-task'
const backendId = 'custom-unified-fixture', mainModel = 'main-original', sideModel = 'routing-fixture'
const fixtureKey = 'synthetic-fixture-key-not-a-real-credential'
const wire = [], sockets = new Set(), held = new Set()
let providerSeq = 0
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('\n') : ''
function sendJson(response, body) { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) } }
function completion(response, message) { sendJson(response, { id: 'fixture-' + (++providerSeq), object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) }
function toolCall(name, args) { return { index: 0, id: 'fixture-call-' + (++providerSeq), type: 'function', function: { name, arguments: JSON.stringify(args) } } }
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'Bearer ' + fixtureKey, 'Only the synthetic credential may reach this loopback fixture')
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/v1/models') return sendJson(response, { data: [mainModel, sideModel].map(id => ({ id, object: 'model', owned_by: 'synthetic-fixture' })) })
    assert.equal(request.method, 'POST'); assert.equal(url.pathname, '/v1/chat/completions')
    let raw = ''
    for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 2_000_000) }
    const body = JSON.parse(raw), messages = body.messages ?? [], last = messages.at(-1), lastUser = [...messages].reverse().find(item => item.role === 'user')
    const userText = textOf(lastUser?.content), tag = (userText.match(/UNIFIED_(?:ROUTE_[A-Z_]+|RECALL)/g) ?? []).at(-1) ?? 'HIDDEN'
    const extraction = messages.some(item => item.role === 'system' && textOf(item.content).includes('You maintain the long-term memory of an assistant.'))
    const row = { model: body.model, tag, tools: (body.tools ?? []).map(item => item.function?.name), lastRole: last?.role, purpose: extraction ? 'memory-extraction' : body.model === sideModel ? 'routing-advice' : 'lead-turn' }
    wire.push(row)
    assert.notEqual(body.model, sideModel, 'A configured legacy routing preference must never request another model')
    assert.equal(body.model, mainModel, 'The Bot must keep its own model')
    if (extraction) { assert.equal(body.tools, undefined); return completion(response, { content: '[]' }) }
    if (last?.role === 'tool') {
      const output = textOf(last.content)
      if (output.includes('UNIFIED_MEMORY_')) {
        const start = output.indexOf('<tool_result_data>\n') + '<tool_result_data>\n'.length
        const payload = JSON.parse(output.slice(start, output.lastIndexOf('\n</tool_result_data>')))
        assert.equal(payload.tool, 'recall')
        const entries = JSON.parse(payload.output)
        row.recall = { count: entries.length, profile: entries.some(item => item.text.includes('UNIFIED_MEMORY_PROFILE') && item.tags?.includes('profile')), journal: entries.some(item => item.text.includes('UNIFIED_MEMORY_JOURNAL') && item.tags?.includes('journal')), legacy: entries.some(item => item.id === 'legacy-memory' && !item.tags?.includes('profile') && !item.tags?.includes('journal')), shared: entries.some(item => item.text.includes('UNIFIED_MEMORY_SHARED') && item.tags?.includes('source:bot:' + botId)), foreign: output.includes('UNIFIED_FOREIGN_PRIVATE') }
        assert.ok(row.recall.profile && row.recall.journal && row.recall.legacy && row.recall.shared && !row.recall.foreign)
        return completion(response, { content: 'UNIFIED_RECALL_FINISHED · Synthetic saved memory was read.' })
      }
      return completion(response, { content: 'UNIFIED_HIDDEN_REVIEW_RECEIVED · Synthetic task assessment recorded.' })
    }
    if (userText.includes('<agent_result>') && userText.includes(hiddenTaskId)) return completion(response, { tool_calls: [toolCall('review_task', { task_id: hiddenTaskId, outcome: 'complete_claimed', summary: 'Synthetic fixture result matches its synthetic request.', evidence: ['The saved fixture result contains the requested synthetic marker; no external action occurred.'] })] })
    if (tag === 'UNIFIED_RECALL') {
      assert.ok(row.tools.includes('recall'))
      return completion(response, { tool_calls: [toolCall('recall', { query: 'UNIFIED_MEMORY', limit: 20, kind: 'all' })] })
    }
    return completion(response, { content: 'UNIFIED_REPLY_' + tag })
  } catch (error) { wire.push({ fixtureError: error.message }); if (!response.headersSent) response.writeHead(500); response.end('Synthetic fixture assertion failed') }
})
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
const origin = 'http://127.0.0.1:' + provider.address().port
const catalog = await fs.readFile(path.join(process.cwd(), 'src/shared/providerCatalog.ts'), 'utf8')
const ids = [...new Set([...catalog.matchAll(/\{\s*id:\s*'([^']+)'/g)].map(match => match[1]).concat(['codex','claude','kimi','grok','pi','droid','opencode']))]
const backends = Object.fromEntries(ids.map(id => [id, { enabled: false, added: false }]))
backends[backendId] = { enabled: true, added: true, providerName: 'Unified synthetic provider', providerProtocol: 'openai', baseUrl: origin + '/v1', credentialOrigin: origin, defaultModelId: mainModel }
await fs.writeFile(path.join(data, 'backend-secrets.json'), JSON.stringify({ version: 1, keys: { [backendId]: Buffer.from('FIXTURE:' + [...fixtureKey].reverse().join('')).toString('base64') } }), { mode: 0o600 })
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: backendId, defaultModelId: mainModel, defaultMode: 'agent', approvalPolicy: 'auto-run', memoryExtraction: 'off', quickDecision: { backendId, modelId: sideModel }, notifications: false, notifyOnTurn: false, runRoutinesWhenClosed: false, runInBackground: false, launchAtLogin: false, backends }))
await fs.writeFile(path.join(data, 'bots', botId + '.json'), JSON.stringify({ id: botId, name: 'Unified Memory Fixture', backendId, modelId: mainModel, systemPrompt: 'Synthetic local-only verification. No external actions.', tools: ['remember','delegate_task'], executionAgent: { backendId, modelId: mainModel }, computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: sessionId, createdAt: 1, updatedAt: 1 }))
await fs.writeFile(path.join(data, 'sessions', sessionId + '.json'), JSON.stringify({ id: sessionId, title: 'Unified memory fixture', cwd: root, botIds: [botId], activeBotId: botId, mode: 'agent', messages: [], todos: [], archived: false, createdAt: 1, updatedAt: 1 }))
const legacy = { id: 'legacy-memory', botId, text: 'UNIFIED_MEMORY_LEGACY remains an unclassified saved note.', source: 'user', createdAt: 1 }
await fs.writeFile(path.join(data, 'memory', botId + '.json'), JSON.stringify({ botId, entries: [legacy] }))
await fs.writeFile(path.join(data, 'memory', 'foreign-bot.json'), JSON.stringify({ botId: 'foreign-bot', entries: [{ id: 'foreign', botId: 'foreign-bot', text: 'UNIFIED_FOREIGN_PRIVATE must stay outside this Bot.', source: 'user', createdAt: 1 }] }))

function installFixture(allowedOrigin) {
  const req = process.getBuiltinModule('module').createRequire(process.execPath), electron = req('electron'), originalFetch = globalThis.fetch
  const fixture = globalThis.__unifiedMemoryFixture = { unexpected: [], dialogs: [] }
  for (const [key, value] of Object.entries({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from('FIXTURE:' + [...value].reverse().join('')), decryptString: bytes => { const value = bytes.toString(); if (!value.startsWith('FIXTURE:')) throw Error('Non-fixture secret refused'); return [...value.slice(8)].reverse().join('') } })) Object.defineProperty(electron.safeStorage, key, { configurable: true, value })
  electron.dialog.showErrorBox = title => { fixture.dialogs.push(title) }
  electron.shell.openExternal = async () => { fixture.unexpected.push('external-open'); throw Error('External browser is disabled in this fixture') }
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    if (url.origin !== allowedOrigin) { fixture.unexpected.push(url.origin + url.pathname); throw Error('Only the loopback synthetic provider is permitted') }
    return originalFetch(input, init)
  }
  void electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel: true })))
  return { encryption: 'synthetic', network: 'one-loopback-origin', externalBrowser: 'disabled' }
}

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
let app, ui, main, logs = '', launches = 0
const rendererErrors = []
const result = { root, evidence, executable, asarSha256: sha256, realElectron: true, actualAccount: false, actualKeychain: false, provider: 'loopback synthetic OpenAI-compatible HTTP', variant: uiOnly ? 'routing-ui-only' : routingOnly ? 'routing-only' : 'memory-and-routing', checks: [], shutdowns: [] }
async function wait(expression, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await ui.evaluate(expression); if (value) return value; if (app.exitCode !== null || app.signalCode !== null) throw Error('The isolated Preview exited'); await delay(100) }
  throw Error('Timed out: ' + expression)
}
async function key(key, extra = {}) { await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, ...extra }); await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, ...extra }); await delay(100) }
async function click(selector) {
  const point = await ui.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing fixture UI target');element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); await delay(100)
}
async function select(selector, value) { await ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`); await wait(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`) }
async function screenshot(name) { const value = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, name + '.png'), Buffer.from(value.data, 'base64')) }
async function launch() {
  const mainPort = await freePort(), uiPort = await freePort(); launches++
  app = spawn(executable, ['--inspect-brk=127.0.0.1:' + mainPort, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + uiPort, '--user-data-dir=' + path.join(root, 'chromium')], { cwd: root, env, stdio: ['ignore','pipe','pipe'] })
  app.stdout.on('data', value => { logs += value }); app.stderr.on('data', value => { logs += value })
  main = await connectInspector(mainPort); await main.send('Debugger.enable')
  const paused = new Promise((resolve, reject) => { const timer = setTimeout(() => { off(); reject(Error('The fixture entry breakpoint was not reached')) }, 10_000); const off = main.on(event => { if (event.method === 'Debugger.paused') { clearTimeout(timer); off(); resolve(event.params.callFrames[0].callFrameId) } }) })
  await main.send('Runtime.runIfWaitingForDebugger')
  const injected = await main.send('Debugger.evaluateOnCallFrame', { callFrameId: await paused, expression: `(${installFixture.toString()})(${JSON.stringify(origin)})`, returnByValue: true })
  assert.equal(injected.exceptionDetails, undefined); assert.equal(injected.result?.value?.encryption, 'synthetic')
  await main.send('Debugger.resume'); await main.send('Debugger.disable')
  ui = await connectInspector(uiPort, 'page'); await ui.send('Runtime.enable')
  ui.on(event => { if (event.method === 'Runtime.exceptionThrown') rendererErrors.push(event.params.exceptionDetails.text) })
  await wait(`!!document.querySelector('#ob-prompt')`)
  const runtime = await main.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return{pid:process.pid,appPath:e.app.getAppPath(),userData:e.app.getPath('userData'),isPackaged:e.app.isPackaged,home:process.getBuiltinModule('os').homedir(),shell:process.env.SHELL,configRoots:Object.fromEntries(['XDG_CONFIG_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','KIMI_CODE_HOME','GROK_HOME','PI_CODING_AGENT_DIR'].map(key=>[key,process.env[key]]))}})()`)
  assert.equal(runtime.appPath, asar); assert.equal(runtime.userData, data); assert.equal(runtime.isPackaged, true)
  assert.equal(runtime.home, env.HOME); assert.equal(runtime.shell, env.SHELL)
  for (const [key, value] of Object.entries(runtime.configRoots)) assert.equal(value, env[key])
  result.runtime = runtime
  const actualExtraction = await ui.evaluate(`window.openbot.settings.get().then(settings=>settings.memoryExtraction)`)
  result.actualMemoryExtraction = actualExtraction
  assert.equal(actualExtraction, 'off', 'The application must preserve the explicitly disabled extraction setting')
  await main.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');e.BrowserWindow.getAllWindows()[0].setSize(1180,820);return true})()`)
  await wait(`window.openbot.backends.list().then(rows=>rows.some(row=>row.id===${JSON.stringify(backendId)}&&row.status==='available'))`, 40_000)
}
async function stop() {
  if (!app || app.exitCode !== null || app.signalCode !== null) return false
  try { await main?.evaluate(`(()=>{setTimeout(()=>process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit(),0);return true})()`) } catch {}
  ui?.close(); main?.close()
  for (let i = 0; i < 60 && app.exitCode === null && app.signalCode === null; i++) await delay(100)
  const graceful = app.exitCode === 0 && app.signalCode === null
  if (app.exitCode === null && app.signalCode === null) { app.kill('SIGTERM'); await delay(300) }
  if (app.exitCode === null && app.signalCode === null) { app.kill('SIGKILL'); for (let i = 0; i < 20 && app.exitCode === null && app.signalCode === null; i++) await delay(100) }
  result.shutdowns.push({ pid: app.pid, graceful, exitCode: app.exitCode, signal: app.signalCode })
  assert.ok(app.exitCode !== null || app.signalCode !== null, 'The owned temporary process must exit')
  return graceful
}
async function openMemory() {
  if (!await ui.evaluate(`!!document.querySelector('#ob-bot-details')`)) await click('.ob-header-bot-trigger')
  await wait(`!!document.querySelector('.ob-memory')`)
  await ui.evaluate(`(()=>{const d=document.querySelector('.ob-memory').closest('details');if(d)d.open=true})()`)
  await wait(`document.querySelector('.ob-memory [aria-label="新记忆"]')?.checkVisibility()`)
}
async function saveMemory(text, kind, shared) {
  await select('.ob-memory [aria-label="记忆类型"]', kind)
  const checked = await ui.evaluate(`document.querySelector('.ob-memory [aria-label="所有 Bot 共享"]').checked`)
  if (checked !== shared) await click('.ob-memory [aria-label="所有 Bot 共享"]')
  await click('.ob-memory [aria-label="新记忆"]'); await ui.send('Input.insertText', { text })
  await click('.ob-memory [aria-label="添加记忆"]')
  await wait(`window.openbot.bots.memory(${JSON.stringify(botId)}).then(entries=>entries.some(entry=>entry.text===${JSON.stringify(text)}))`)
}
async function closeDetails() { if (await ui.evaluate(`!!document.querySelector('#ob-bot-details')`)) await click('[aria-label="关闭 Bot 详情"]') }
async function inspectRetiredRouting(captureName) {
  await closeDetails(); await key(',', { code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 4 })
  await wait(`!!document.querySelector('#ob-set-tab-bots')`); await click('#ob-set-tab-bots')
  assert.equal(await ui.evaluate(`!!document.querySelector('[aria-label="判断模型连接"],[aria-label="派发判断模型"]')`), false, 'Retired settings must have no editable entry')
  assert.deepEqual(await ui.evaluate(`window.openbot.settings.get().then(s=>s.quickDecision)`), { backendId, modelId: sideModel }, 'Opening settings must preserve old data without enabling it')
  const layout = await ui.evaluate(`(()=>{const m=document.querySelector('.ob-modal');return{viewport:[innerWidth,innerHeight],theme:document.documentElement.dataset.theme,pageOverflow:document.documentElement.scrollWidth-innerWidth,modalOverflow:m.scrollWidth-m.clientWidth}})()`)
  await screenshot(captureName ?? 'retired-routing-absent')
  await key('Escape', { windowsVirtualKeyCode: 27 }); await wait(`!document.querySelector('[role=dialog]')`)
  return layout
}
async function send(tag) {
  const before = await ui.evaluate(`window.openbot.sessions.get(${JSON.stringify(sessionId)}).then(s=>s.messages.length)`), start = wire.length
  assert.equal(await ui.evaluate(`window.openbot.agent.send(${JSON.stringify(sessionId)},${JSON.stringify(tag)})`), true)
  await wait(`(async()=>{if(await window.openbot.agent.isRunning(${JSON.stringify(sessionId)}))return false;const s=await window.openbot.sessions.get(${JSON.stringify(sessionId)});return s.messages.length>${before}&&s.messages.slice(${before}).some(m=>m.role==='assistant'&&!m.internal&&!m.uiOnly&&m.content.includes(${JSON.stringify(tag === 'UNIFIED_RECALL' ? 'UNIFIED_RECALL_FINISHED' : 'UNIFIED_REPLY_' + tag)}))})()`, 35_000)
  const fresh = wire.slice(start)
  assert.ok(fresh.some(row => row.model === mainModel)); assert.equal(fresh.some(row => row.fixtureError), false)
  const selected = await ui.evaluate(`Promise.all([window.openbot.bots.list(),window.openbot.settings.get()]).then(([bots,settings])=>({bot:bots.find(b=>b.id===${JSON.stringify(botId)}).modelId,defaultModel:settings.defaultModelId}))`)
  assert.deepEqual(selected, { bot: mainModel, defaultModel: mainModel })
  return fresh
}

try {
  await launch()
  if (uiOnly) {
    result.layouts = []
    for (const [theme, width, height] of [['light',1120,800],['dark',740,740]]) {
      await ui.evaluate(`window.openbot.settings.update({theme:${JSON.stringify(theme)}})`)
      await wait(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`)
      await main.evaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0].setSize(${width},${height})`)
      const layout = await inspectRetiredRouting('retired-routing-' + theme + '-' + width)
      result.layouts.push(layout)
      assert.ok(layout.pageOverflow <= 1 && layout.modalOverflow <= 1, JSON.stringify(layout))
    }
    assert.equal(wire.some(row=>row.model===sideModel), false, 'Opening settings must not run inference')
    result.checks.push('retired routing entry absent in light-wide and dark-narrow settings', 'no horizontal overflow', 'Escape returns to chat', 'opening settings does not start inference')
  } else {
  let saved
  if (!routingOnly) {
  await openMemory()
  await saveMemory('UNIFIED_MEMORY_PROFILE prefers concise verification reports.', 'profile', false)
  await saveMemory('UNIFIED_MEMORY_JOURNAL records a synthetic dated checkpoint.', 'journal', false)
  await saveMemory('UNIFIED_MEMORY_SHARED uses a shared synthetic preference.', 'profile', true)
  await wait(`document.querySelectorAll('.ob-memory-provenance').length===1`)
  assert.ok(await ui.evaluate(`document.querySelector('.ob-memory [aria-label="档案"]')?.textContent.includes('UNIFIED_MEMORY_PROFILE')&&document.querySelector('.ob-memory [aria-label="档案"]')?.textContent.includes('UNIFIED_MEMORY_SHARED')`))
  assert.ok(await ui.evaluate(`document.querySelector('.ob-memory [aria-label="日记"]')?.textContent.includes('UNIFIED_MEMORY_JOURNAL')`))
  assert.ok(await ui.evaluate(`document.querySelector('.ob-memory [aria-label="其他记忆"]')?.textContent.includes('UNIFIED_MEMORY_LEGACY')`))
  assert.match(await ui.evaluate(`document.querySelector('.ob-memory-provenance').textContent`), /Unified Memory Fixture/)
  saved = await ui.evaluate(`window.openbot.bots.memory(${JSON.stringify(botId)})`)
  assert.deepEqual(saved.find(entry => entry.id === legacy.id), legacy)
  assert.ok(saved.some(entry => entry.tags?.includes('journal')))
  assert.ok(saved.some(entry => entry.tags?.includes('profile') && entry.tags?.includes('source:bot:' + botId)))
  await screenshot('memory-groups-light')
  await ui.evaluate(`window.openbot.settings.update({theme:'dark'})`); await wait(`document.documentElement.dataset.theme==='dark'`); await screenshot('memory-groups-dark')
  await closeDetails()
  }
  await inspectRetiredRouting()
  for (const tag of ['UNIFIED_ROUTE_LEGACY', 'UNIFIED_ROUTE_FOLLOWUP']) {
    assert.equal((await send(tag)).filter(row => row.model === sideModel).length, 0, 'Ordinary lead turns must ignore configured legacy routing')
  }
  if (!routingOnly) {
    const recall = await send('UNIFIED_RECALL'); assert.ok(recall.some(row => row.recall?.profile && row.recall.journal && row.recall.legacy && row.recall.shared && !row.recall.foreign))
    result.checks.push('real memory UI/IPC categories/shared provenance', 'legacy shape preserved', 'actual application-host recall')
  }
  result.checks.push('configured legacy routing makes zero side calls', 'ordinary and follow-up turns retain the chosen Bot model')
  const safety = await main.evaluate(`globalThis.__unifiedMemoryFixture`); assert.deepEqual(safety, { unexpected: [], dialogs: [] })
  assert.equal(await stop(), true, 'Restart readback requires normal shutdown, not a forced kill')
  // Only our stopped temporary profile is changed, to exercise actual startup inbox delivery.
  await fs.writeFile(path.join(data, 'tasks', hiddenTaskId + '.json'), JSON.stringify({ id: hiddenTaskId, botId, requesterBotId: botId, sourceSessionId: sessionId, sessionId: 'unified-hidden-execution', title: 'Synthetic hidden wake', prompt: 'Record the synthetic fixture result.', result: 'UNIFIED_HIDDEN_TASK synthetic result.', status: 'completed', deliveryStatus: 'pending', executionAgent: { backendId, modelId: mainModel }, createdAt: Date.now(), updatedAt: Date.now() }))
  await fs.writeFile(path.join(data, 'sessions', 'unified-hidden-execution.json'), JSON.stringify({ id: 'unified-hidden-execution', title: 'Synthetic completed execution', cwd: root, botIds: [botId], activeBotId: botId, mode: 'agent', messages: [], todos: [], archived: true, createdAt: 1, updatedAt: 1 }))
  const wakeStart = wire.length
  await launch()
  await wait(`window.openbot.tasks.get(${JSON.stringify(hiddenTaskId)}).then(t=>t?.deliveryStatus==='delivered'&&t.review?.outcome==='complete_claimed')`, 40_000)
  assert.equal(wire.slice(wakeStart).filter(row => row.model === sideModel).length, 0, 'An internal result wake must not invoke retired routing')
  assert.ok(wire.slice(wakeStart).some(row => row.model === mainModel))
  assert.equal(await ui.evaluate(`window.openbot.settings.get().then(s=>s.quickDecision?.modelId)`), sideModel)
  result.checks.push('normal restart preserves inert legacy settings', 'pending result hidden wake makes no side call')
  if (!routingOnly) {
    const restored = await ui.evaluate(`window.openbot.bots.memory(${JSON.stringify(botId)})`)
    assert.deepEqual(restored, saved)
    const recalledAgain = await send('UNIFIED_RECALL'); assert.ok(recalledAgain.some(row => row.recall?.count === 4))
    await openMemory(); await screenshot('memory-restored-after-restart')
    result.checks.push('normal restart retains memory', 'actual recall after restart')
  }
  }
  assert.deepEqual(await main.evaluate(`globalThis.__unifiedMemoryFixture`), { unexpected: [], dialogs: [] })
  assert.deepEqual(rendererErrors, [])
  assert.equal(wire.some(row => row.fixtureError), false)
  result.ok = true
} catch (error) {
  result.ok = false; result.failure = error.stack; process.exitCode = 1
  if (ui) await screenshot('failure').catch(() => {})
} finally {
  await stop()
  for (const response of held) response.destroy()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => provider.close(resolve))
  result.launches = launches; result.rendererErrors = rendererErrors
  await fs.writeFile(path.join(evidence, 'provider-wire.json'), JSON.stringify(wire, null, 2) + '\n')
  await fs.writeFile(path.join(evidence, 'electron.log'), logs)
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ok: result.ok, evidence, launches, checks: result.checks, failure: result.failure }))
}
