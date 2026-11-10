import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const backend = process.argv[2] || 'codex'
const agentOnly = process.argv.includes('--agent')
const binaries = { codex: '.local/bin/codex', kimi: '.kimi-code/bin/kimi', grok: '.local/bin/grok', claude: '/opt/homebrew/bin/claude', pi: '/opt/homebrew/bin/pi' }
assert.ok(binaries[backend], 'Pass codex, kimi, grok, claude or pi')
const binary = path.isAbsolute(binaries[backend]) ? binaries[backend] : path.join(os.homedir(), binaries[backend])
const repo = process.cwd(), root = await fs.mkdtemp(path.join(os.tmpdir(), `blinky-switch-${backend}-`)), data = path.join(root, 'data'), trace = path.join(root, 'wire.jsonl')
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
const proxy = path.join(root, backend)
await fs.writeFile(proxy, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(repo, 'Scripts/model-switch-proxy.cjs'))})\n`)
await fs.chmod(proxy, 0o700)
const fakeLead = path.join(root, 'fake-claude-lead')
await fs.writeFile(fakeLead, `#!${process.execPath}\n` + String.raw`
const a=process.argv.slice(2),out=x=>console.log(JSON.stringify(x));
if(a.includes('--version')){console.log('Claude Code 2.1.318');process.exit()}
if(a[0]==='auth'){out({loggedIn:true,authMethod:'fixture'});process.exit()}
process.stdin.resume();process.stdin.on('end',()=>{out({type:'assistant',message:{content:'Isolated execution result received.'}});out({type:'result',result:'Isolated execution result received.',is_error:false})});
`)
await fs.chmod(fakeLead, 0o700)
// Only this process is configured. No CLI profile/auth file is copied or edited.
const extraArgs = backend === 'codex' ? ['-c', 'features.shell_tool=false', '-c', 'web_search="disabled"'] : backend === 'grok' ? ['--disable-web-search', '--no-subagents'] : backend === 'pi' ? ['--no-tools', '--no-extensions', '--no-skills', '--no-context-files'] : []
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'light', memoryExtraction: 'off', approvalPolicy: 'ask-every-time', defaultBackendId: backend, defaultModelId: 'default', backends: { [backend]: { enabled: true, added: true, command: proxy, extraArgs }, ...(agentOnly ? { claude: { enabled: true, added: true, command: fakeLead } } : {}) } }))
await fs.writeFile(path.join(data, 'bots/probe.json'), JSON.stringify({ id: 'probe', name: 'Model Switch QA', systemPrompt: 'This is an isolated text-only configuration test. Do not call tools, read files, browse, send messages, or delegate. Track synthetic QA markers stated by the user across this conversation. Only respond with the requested marker values.', emoji: '🧪', color: '#7c9cff', backendId: agentOnly ? 'claude' : backend, modelId: agentOnly ? 'sonnet' : 'default', ...(agentOnly ? { executionAgent: { backendId: backend, modelId: 'default' } } : {}), followsDefault: false, tools: [], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 }))
const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const app = spawn(path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { cwd: repo, env: { ...process.env, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data, BLINKY_QA_BACKEND: backend, BLINKY_QA_REAL_CLI: binary, BLINKY_QA_TRACE: trace }, stdio: ['ignore', 'ignore', 'ignore'] })
let ws, seq = 0
const pending = new Map(), report = { backend, role: agentOnly ? 'executionAgent' : 'Bot', binary, root, stages: [] }
const wire = async () => (await fs.readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
function cmd(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
async function wait(expression, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(150) } throw Error('Timed out: ' + expression) }
const bot = () => evaluate(`window.openbot.bots.list().then(bs=>bs.find(b=>b.id==='probe'))`)
const section = `#ob-bot-details section[aria-label="${agentOnly ? '执行 Agent' : '对话模型'}"]`
async function select(label, value) {
  const selector = JSON.stringify(`${section} select[aria-label="${label}"]`)
  await wait(`Array.from(document.querySelector(${selector})?.options??[]).some(o=>o.value===${JSON.stringify(value)})`)
  await evaluate(`(()=>{const e=document.querySelector(${selector});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await wait(`document.querySelector(${selector})?.value===${JSON.stringify(value)}`)
}
async function configure(model, thinking) {
  await evaluate(`document.querySelector('.ob-header-bot-trigger').click()`)
  await wait(`!!document.querySelector('#ob-bot-details')`)
  await select('模型', model)
  if (['codex', 'kimi', 'grok'].includes(backend)) await select('思考深度', thinking || '')
  await evaluate(`document.querySelector('#ob-bot-details .ob-bot-editor-save .ob-btn-primary').click()`)
  const value = agentOnly ? 'bot.executionAgent' : 'bot'
  await wait(`window.openbot.bots.list().then(bs=>bs.some(bot=>bot.id==='probe'&&${value}?.modelId===${JSON.stringify(model)}&&(${value}?.thinking??'')===${JSON.stringify(thinking || '')}))`)
  await evaluate(`document.querySelector('[aria-label="关闭 Bot 详情"]').click()`)
}
try {
  let targets
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break } catch {} await delay(100) }
  assert.ok(targets?.some(t => t.type === 'page'), 'No isolated Electron renderer')
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
  await wait(`!!document.querySelector('#ob-prompt')`)
  const info = await wait(`window.openbot.backends.list().then(a=>{const b=a.find(x=>x.id===${JSON.stringify(backend)});return b&&(b.models.some(m=>m.id!=='default')||(${JSON.stringify(backend)}==='claude'&&b.cliAuth))?b:null})`, 45_000)
  report.detection = { status: info.status, auth: info.cliAuth?.state }
  report.catalog = info.models.map(m => ({ id: m.id, thinking: m.supportedThinking, isDefault: m.isDefault }))
  let a, b, low, high
  const ids = info.models.map(m => m.id)
  if (backend === 'codex') { a = ids.find(x => x === 'gpt-6.1-sol') || ids.find(x => x !== 'default'); b = ids.find(x => x === 'gpt-6-luna') || ids.find(x => x !== 'default' && x !== a); low = 'low'; high = 'high' }
  else if (backend === 'claude') { a = 'haiku'; b = 'sonnet' }
  else { const choices = ids.filter(x => x !== 'default'); a = choices[0]; b = choices[1] || choices[0]; low = backend === 'kimi' || backend === 'grok' ? 'low' : undefined; high = backend === 'kimi' || backend === 'grok' ? 'high' : undefined; if(backend==='kimi') { b=ids.includes('kimi-code/k3')?'kimi-code/k3':b; const allowed=info.models.find(m=>m.id===b)?.supportedThinking||[]; high=allowed.includes('high')?'high':allowed.includes('max')?'max':undefined } }
  assert.ok(a && b, 'No usable model choices')
  report.distinctModels = a !== b
  const session = (await bot()).activeConversationId
  await evaluate(`window.openbot.sessions.setCwd(${JSON.stringify(session)},${JSON.stringify(root)})`)
  const markers = ['QA_A_COBALT_7416', 'QA_B_MAPLE_8923', 'QA_DEFAULT_QUARTZ_6318', 'QA_RETURN_AMBER_2549']
  for (const [index, [model, thinking]] of [[a, low], [b, high], ['default', undefined], [a, low]].entries()) {
    await configure(model, thinking)
    const before = (await wire()).length, old = await evaluate(`window.openbot.sessions.get(${JSON.stringify(session)}).then(s=>s.messages.length)`)
    const prompt = `${agentOnly ? 'User context assigned to this independent task: ' + markers.slice(0,index).join(', ') + '. ' : ''}Synthetic marker ${index + 1} is ${markers[index]}. Return every synthetic QA marker from the user in this conversation so far, in order. Do not use any tool. Do not invent markers. Only list marker values.`
    const accepted = agentOnly ? await evaluate(`window.openbot.tasks.create('probe',${JSON.stringify(prompt)},'Model switch QA ${index + 1}')`) : await evaluate(`window.openbot.agent.send(${JSON.stringify(session)},${JSON.stringify(prompt)})`)
    let task
    if(agentOnly) {
      assert.ok(accepted?.id, 'Independent task not created')
      task=await wait(`window.openbot.tasks.list().then(ts=>ts.find(t=>t.id===${JSON.stringify(accepted.id)}&&['completed','failed','cancelled'].includes(t.status)))`,150_000)
      assert.equal(task.status,'completed',task.error)
      assert.equal((await bot()).backendId,'claude','Worker settings changed the lead')
    }
    else
    assert.equal(accepted, true)
    const messages = agentOnly ? await evaluate(`window.openbot.sessions.get(${JSON.stringify(task.sessionId)}).then(s=>s.messages)`) : await wait(`(async()=>{if(await window.openbot.agent.isRunning(${JSON.stringify(session)}))return null;const s=await window.openbot.sessions.get(${JSON.stringify(session)});return s.messages.length>${old}?s.messages:null})()`, 150_000)
    const fresh = agentOnly ? messages : messages.slice(old), replies = fresh.filter(m => m.role === 'assistant' && !m.internal && !m.uiOnly).map(m => m.content).join('\n')
    const rows = (await wire()).slice(before), stage = { stage: index + 1, selection: { model, thinking: thinking || null }, response: replies, context: markers.slice(0, index + 1).map(marker => ({ marker, recalled: replies.includes(marker) })), requests: rows.filter(r => r.direction === 'request'), nativeModels: rows.filter(r => r.direction === 'model' || r.direction === 'response') }
    report.stages.push(stage)
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    assert.ok(!fresh.some(m => m.error), `Stage ${index + 1} returned an error`)
    assert.ok(stage.context.every(x => x.recalled), `Stage ${index + 1} lost user context`)
    if (backend === 'codex') { const turn = rows.find(r => r.direction === 'request' && r.method === 'turn/start' && r.markers?.includes(markers[index])); assert.ok(turn, 'No actual turn/start for this user input'); stage.primaryWire = turn; assert.equal(turn.model, model === 'default' ? null : model); assert.equal(turn.effort, thinking || null) }
    if (backend === 'kimi' || backend === 'grok') { const options = rows.filter(r => r.method === 'session/set_config_option'); if (model !== 'default') assert.ok(options.some(r => r.configId === 'model' && r.value === model)); if (thinking) assert.ok(options.some(r => ['thinking', 'reasoning_effort'].includes(r.configId) && r.value === thinking)) }
    console.log(JSON.stringify({ backend, stage: index + 1, model, thinking: thinking || null, recalled: stage.context.length, actualCli: true }))
  }
  report.passed = true
} catch (error) { report.passed = false; report.failure = String(error.message); process.exitCode = 1 }
finally {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
  ws?.close(); app.kill('SIGTERM'); await Promise.race([new Promise(resolve => app.once('exit', resolve)), delay(1500)]); if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
  await fs.rm(data, { recursive: true, force: true })
  console.log(JSON.stringify({ backend, passed: report.passed, failure: report.failure, report: path.join(root, 'report.json') }))
}
