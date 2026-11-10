// UI audit capture: drives an isolated app instance through the key surfaces
// and saves screenshots for design/content/interaction review.
//
//   node Scripts/ui-audit-capture.mjs <output-dir>
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd()
const outDir = process.argv[2] || '/tmp/blinky-ui-audit'
await fs.mkdir(outDir, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-uiaudit-'))
const data = path.join(root, 'data'); await fs.mkdir(data)
const fake = path.join(root, 'fake-codex')
await fs.writeFile(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let n = 0; const owner = process.ppid; setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 200).unref();
const send = x => process.stdout.write(JSON.stringify(x) + String.fromCharCode(10));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: {} });
  else if (r.method === 'model/list') send({ id: r.id, result: { data: [{ model: 'test-model', displayName: 'Test Model' }], nextCursor: null } });
  else if (r.method === 'thread/start' || r.method === 'thread/resume') send({ id: r.id, result: { approvalsReviewer: 'auto_review', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', networkAccess: false }, thread: { id: 'test-thread' } } });
  else if (r.method === 'turn/start') { n++; const turn = 'turn-' + n; send({ id: r.id, result: { turn: { id: turn } } }); send({ method: 'turn/started', params: { turn: { id: turn }, threadId: 'test-thread' } }); const t = r.params.input[0].text; const hold = t.includes('hold for crash'); send({ method: 'item/agentMessage/delta', params: { itemId: 'item-' + n, delta: hold ? 'holding-active' : '已处理：' + t.slice(-30) } }); if (!hold) setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed', items: [] } } }), 200); }
});
`); await fs.chmod(fake, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'test-model', memoryExtraction: 'off', backends: { codex: { enabled: true, command: fake, extraArgs: [] }, openrouter: { enabled: true, defaultModelId: 'gpt-5' } } }))
await fs.mkdir(path.join(data, 'bots'))
await fs.mkdir(path.join(data, 'tasks'))
const bot = (id, name, backendId, modelId) => ({ id, name, description: '测试 Bot', systemPrompt: '你是测试助手。', emoji: '✨', color: '#7c9cff', backendId, modelId, followsDefault: false, tools: [], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 })
await fs.writeFile(path.join(data, 'bots', 'developer.json'), JSON.stringify(bot('developer', 'Developer', 'codex', 'test-model')))
await fs.writeFile(path.join(data, 'bots', 'reviewer.json'), JSON.stringify(bot('reviewer', 'Reviewer', 'openrouter', 'gpt-5')))
const task = (id, title, status, progress, extra = {}) => ({ id, botId: 'developer', sessionId: 'exec-' + id, prompt: title, title, status, createdAt: Date.now() - 3600e3, updatedAt: Date.now() - 300e3, sourceSessionId: 'seeded-later', plan: { priority: 'normal', priorityReason: '', dependencies: [], workspace: 'auto', workspaceReason: '', sourceCwd: root, sessionReason: '', context: { summary: title, categories: ['功能开发'], scope: ['src/' + id], boundaries: ['不发布'] } }, ...extra })
await fs.writeFile(path.join(data, 'tasks', 't-run.json'), JSON.stringify(task('t-run', '报表导出优化', 'running', undefined, { progress: { phase: 'running', detail: '正在处理“导出管道改造”。', milestones: [], updatedAt: Date.now() } })))
await fs.writeFile(path.join(data, 'tasks', 't-wait.json'), JSON.stringify(task('t-wait', '登录双因素认证', 'running', undefined, { progress: { phase: 'waiting_user', detail: '等待你确认验证方式。', blocker: '等待你确认验证方式，请在任务中回答。', milestones: [{ text: '流程梳理完成', at: Date.now() - 600e3 }], updatedAt: Date.now() } })))
await fs.writeFile(path.join(data, 'tasks', 't-done.json'), JSON.stringify(task('t-done', '数据迁移核对', 'completed', undefined, { result: '迁移核对完成：1024 条记录一致，报告已生成。', review: { outcome: 'complete_claimed', summary: '抽样与全量核对均一致', evidence: ['对比脚本输出'], recordedAt: Date.now() } })))

const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { cwd: repo, env: { ...process.env, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data }, stdio: ['ignore', 'ignore', 'ignore'] })
let ws; const pending = new Map(); let seq = 0
const cmd = (m, p = {}) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
const evalJs = async (expression) => { const v = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error(v.exceptionDetails.text + ' ' + JSON.stringify(v.exceptionDetails.exception).slice(0, 200)); return v.result.value }
const wait = async (expr, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return; await delay(120) } throw new Error('timeout: ' + expr.slice(0, 80)) }
const shot = async (name) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64')); console.log('shot', name) }
let targets; const end = Date.now() + 30000
while (Date.now() < end) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break } catch { } await delay(100) }
const target = targets.find(t => t.type === 'page'); ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.rej(Error(JSON.stringify(m.error))) : x.res(m.result) } }
try {
  await wait(`Boolean(document.querySelector('#ob-prompt') && document.querySelector('.ob-side-list'))`)
  await delay(600)
  const submit = async (text) => { await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`) }
  await submit('帮我把报表导出改成异步管道')
  await wait(`document.body.innerText.includes('已处理')`)
  await wait(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Developer');return !(await window.openbot.agent.isRunning(b.activeConversationId))})()`,20000)
  await submit('顺便补充导出进度的日志')
  await wait(`(document.body.innerText.match(/已处理/g)||[]).length>=2`)
  await delay(400)
  await shot('01-chat-light')
  // queued message with resume control: start a never-ending turn then enqueue
  await evalJs(`(()=>{const e=document.querySelector('#ob-prompt');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,'hold for crash');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
  await wait(`document.body.innerText.includes('holding-active')`)
  await evalJs(`(async()=>{const b=(await window.openbot.bots.list()).find(x=>x.name==='Developer');await window.openbot.agent.pauseQueue(b.activeConversationId,true);await window.openbot.agent.enqueue(b.activeConversationId,'排队：导出日志级别改成 debug',[])})()`)
  await wait(`document.body.innerText.includes('排队：导出日志级别')`)
  await delay(500)
  await shot('02-queue-resume')
  // bot details panel with the task list (seeded tasks show once the source session exists; at minimum the panel chrome)
  await evalJs(`document.querySelector('[aria-label="Edit Developer"]').click()`)
  await wait(`!!document.querySelector('#ob-bot-name')`)
  await delay(700)
  await shot('03-bot-editor-tasks')
  await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`)
  await delay(300)
  // settings
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}))`)
  await wait(`!!document.querySelector('.ob-settings') || document.body.innerText.includes('设置')`)
  await delay(500)
  await shot('04-settings')
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='通知');if(b)b.click();return !!b})()`)
  await delay(500)
  await shot('05-settings-notifications')
  await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`)
  await delay(400)
  await evalJs(`document.querySelector('.ob-side-profile').click()`)
  await delay(300)
  await evalJs(`Array.from(document.querySelectorAll('[role=menuitem]')).find(b=>['工具','Tools'].includes(b.textContent.trim())).click()`)
  await wait(`!!document.querySelector('[data-tools]')`, 15000)
  await delay(600)
  await shot('05b-tools-sync')
  await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`)
  await delay(300)
  // palette
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`)
  await wait(`!!document.querySelector('[aria-label="Command palette"]')`)
  await shot('06-palette')
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await delay(300)
  // create bot dialog
  await evalJs(`document.querySelector('[aria-label="Create a bot"]').click()`)
  await wait(`!!document.querySelector('#ob-create-bot-name')`)
  await delay(400)
  await shot('07-create-bot')
  await evalJs(`document.querySelector('[aria-label="Close dialog"]').click()`)
  await delay(300)
  // rooms
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}))`)
  await wait(`document.body.innerText.includes('设置')`)
  await evalJs(`(()=>{const b=document.querySelector('[data-open-rooms]');if(b)b.click();return !!b})()`)
  await delay(600)
  await shot('08-rooms')
  await evalJs(`document.querySelector('[aria-label="Close dialog"]')?.click()`)
  await delay(300)
  // dark theme home
  await evalJs(`window.openbot.settings.update({theme:'dark'})`)
  await delay(700)
  await shot('09-chat-dark')
  console.log('DONE ->', outDir)
} finally {
  child.kill('SIGTERM'); await delay(500); if (child.exitCode === null) child.kill('SIGKILL')
  await fs.rm(root, { recursive: true, force: true })
}
