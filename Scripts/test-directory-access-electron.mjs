/** Real isolated Electron + app gateway; model responses use a local protocol fixture. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'

const repo = process.cwd()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-directory-electron-'))
const baseline = process.env.BLINKY_DIRECTORY_BASELINE === '1'
const executable = process.env.BLINKY_DIRECTORY_EXECUTABLE || path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const packaged = Boolean(process.env.BLINKY_DIRECTORY_EXECUTABLE)
if (packaged && process.env.BLINKY_DIRECTORY_ASAR_SHA) {
  assert.ok(executable.startsWith('/Volumes/'), 'Use the read-only mounted Preview')
  const bundle = executable.slice(0, executable.indexOf('.app/') + 4)
  const asar = path.join(bundle, 'Contents/Resources/app.asar')
  assert.equal(createHash('sha256').update(await fs.readFile(asar)).digest('hex'), process.env.BLINKY_DIRECTORY_ASAR_SHA)
  assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).blinkyBuildChannel, 'preview')
}
const isolatedEnvironment = await connectionTestEnvironment(root)
const scenarios = baseline ? ['baseline'] : ['auto', 'ask', 'deny', 'high-risk']
const receipts = []

for (const scenario of scenarios) {
  const run = path.join(root, scenario), data = path.join(run, 'data'), outside = path.join(run, 'outside')
  const trace = path.join(run, 'trace.json'), fake = path.join(run, 'fixture-codex')
  await fs.mkdir(path.join(data, 'bots'), { recursive: true }); await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'fixture.txt'), 'directory fixture\n')
  const tools = ['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'shell']
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    language: 'zh-CN', theme: 'light', defaultBackendId: 'codex', defaultModelId: 'fixture-model',
    approvalPolicy: scenario === 'ask' ? 'ask-every-time' : 'auto-run',
    denylist: scenario === 'deny' ? ['tool:list_dir'] : [], memoryExtraction: 'off',
    backends: { codex: { enabled: true, command: fake, extraArgs: [] } }
  }))
  await fs.writeFile(path.join(data, 'bots', 'fixture.json'), JSON.stringify({
    id: 'fixture', name: 'Directory Fixture', description: 'Isolated directory regression',
    systemPrompt: 'Use only the local fixture.', emoji: '✨', color: '#7c9cff',
    backendId: 'codex', modelId: 'fixture-model', followsDefault: false,
    tools, computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1
  }))
  await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), readline = require('node:readline'), path = require('node:path');
const args = process.argv.slice(2), outside = process.env.DIRECTORY_FIXTURE_OUTSIDE;
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit() }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit() }
const config = args.find(x => x.startsWith('mcp_servers.openbot=')) || '';
const url = config.match(/url="([^"]+)"/)?.[1], token = config.match(/bearer_token_env_var="([^"]+)"/)?.[1];
const send = x => process.stdout.write(JSON.stringify(x) + '\n'), parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0) } catch { process.exit() } }, 200).unref();
readline.createInterface({input: process.stdin}).on('line', async line => {
 try {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({id:r.id, result:{}});
  else if (r.method === 'model/list') send({id:r.id,result:{data:[{model:'fixture-model',displayName:'Fixture'}],nextCursor:null}});
  else if (r.method === 'thread/start' || r.method === 'thread/resume') send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'directory-fixture-thread'}}});
  else if (r.method === 'turn/start') {
   const turn='directory-turn', scenario=process.env.DIRECTORY_FIXTURE_SCENARIO;
   send({id:r.id,result:{turn:{id:turn}}}); send({method:'turn/started',params:{threadId:'directory-fixture-thread',turn:{id:turn}}});
   const file=path.join(outside,'fixture.txt'), actions=scenario==='auto' ? [
    ['list_dir',{path:outside}], ['read_file',{path:file}], ['glob',{path:outside,pattern:'*.txt'}],
    ['grep',{path:outside,pattern:'directory fixture'}], ['write_file',{path:path.join(outside,'new.txt'),content:'new fixture'}],
    ['edit_file',{path:file,old_string:'directory fixture',new_string:'edited fixture'}],
    ['shell',{command:'pwd',cwd:outside}], ['shell',{command:'cat '+JSON.stringify(file)}]
   ] : scenario==='high-risk' ? [['shell',{command:'rm fixture.txt',cwd:outside}]] : [['list_dir',{path:outside}]];
   const results=[];
   for (const [name, arguments_] of actions) {
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[token]},body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name,arguments:arguments_}})});
    results.push({name,response:await response.json()});
   }
   fs.writeFileSync(process.env.DIRECTORY_FIXTURE_TRACE,JSON.stringify(results));
   send({method:'item/started',params:{item:{type:'agentMessage',id:'fixture-final',phase:'final_answer',text:''}}});
   send({method:'item/agentMessage/delta',params:{itemId:'fixture-final',delta:'DIRECTORY_FIXTURE_COMPLETE'}});
   send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}});
  }
 } catch(e) { fs.writeFileSync(process.env.DIRECTORY_FIXTURE_TRACE,JSON.stringify({fixtureError:e.message})) }
});
`)
  await fs.chmod(fake, 0o700)
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  let logs = '', ws, seq = 0, seenCards = 0
  const pending = new Map()
  const child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], {
    cwd: repo, env: { ...isolatedEnvironment, SHELL: '/bin/sh', BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data,
      DIRECTORY_FIXTURE_OUTSIDE: outside, DIRECTORY_FIXTURE_SCENARIO: scenario, DIRECTORY_FIXTURE_TRACE: trace },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', x => { logs += x }); child.stderr.on('data', x => { logs += x })
  child.on('error', error => { logs += '\nspawn: ' + error.message })
  async function cmd(method, params = {}) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)) }, 10000)
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  async function until(fn, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await fn()) return; await delay(100) }
    throw Error(`timeout ${label}; ${logs.slice(-1800)}`)
  }
  try {
    let target
    await until(async () => {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); return !!target } catch { return false }
    }, 'Electron renderer')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.onmessage = event => {
      const value = JSON.parse(event.data), entry = pending.get(value.id)
      if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result) }
    }
    await until(() => evaluate(`!!document.querySelector('#ob-prompt')`), 'composer')
    await until(() => evaluate(`window.openbot.backends.list().then(xs=>xs.some(x=>x.id==='codex'&&x.status==='available'))`), 'fixture backend')
    await evaluate(`window.directoryApprovalEvents=[];window.directoryErrors=[];window.openbot.on(e=>{if(e.type==='approval-request')window.directoryApprovalEvents.push(e.request);if(e.type==='error')window.directoryErrors.push(e.message)})`)
    await evaluate(`(()=>{const e=document.querySelector('#ob-prompt');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Run directory fixture');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await until(() => evaluate(`!!document.querySelector('.ob-composer button.ob-btn-primary:not(:disabled)')`), 'React composer ready')
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await until(() => evaluate(`document.querySelector('#ob-prompt').value === ''`), 'user request submitted')
    const mustAsk = ['baseline', 'ask', 'high-risk'].includes(scenario)
    if (mustAsk) {
      await until(() => evaluate(`!!document.querySelector('.ob-approval')`), 'expected approval')
      const state = await evaluate(`({card:document.querySelector('.ob-approval').innerText,composerUsable:!document.querySelector('#ob-prompt').disabled})`)
      assert.equal(state.composerUsable, true)
      assert.match(state.card, scenario === 'high-risk' ? /rm fixture.txt/ : /Read a path outside the workspace/)
      await fs.writeFile(path.join(run, 'approval.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'))
      await delay(500)
      await evaluate(`Array.from(document.querySelectorAll('.ob-approval button')).find(x=>x.textContent.includes('拒绝')).click()`)
      await until(() => evaluate(`window.directoryErrors.some(x=>x.includes('操作未获批准'))&&!document.querySelector('.ob-approval')`), 'rejection stopped the turn')
      seenCards = 1
    }
    // Rejection intentionally stops the app turn and its CLI, so that branch
    // is proven by the real error event and unchanged file, not a CLI receipt.
    if (!mustAsk) await until(async () => { try { return Array.isArray(JSON.parse(await fs.readFile(trace, 'utf8'))) } catch { return false } }, 'tool receipt')
    const results = mustAsk ? [] : JSON.parse(await fs.readFile(trace, 'utf8'))
    const events = await evaluate('window.directoryApprovalEvents')
    assert.equal(events.length, mustAsk ? 1 : 0)
    assert.equal(await evaluate(`!document.querySelector('#ob-prompt').disabled`), true)
    if (scenario === 'auto') {
      assert.equal(results.length, 8)
      for (const result of results) { assert.ok(!result.response.error, JSON.stringify(result)); assert.ok(!result.response.result?.isError, JSON.stringify(result)) }
      const toolText = entry => {
        const raw = entry.response.result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const start = raw.indexOf('<tool_result_data>\n')
        return start < 0 ? raw : JSON.parse(raw.slice(start + '<tool_result_data>\n'.length, raw.lastIndexOf('\n</tool_result_data>'))).output
      }
      assert.ok(toolText(results[6]).includes(outside), 'The real shell must execute pwd in the outside directory')
      assert.match(toolText(results[7]), /edited fixture/, 'The real shell must read the outside fixture')
      assert.equal(await fs.readFile(path.join(outside, 'fixture.txt'), 'utf8'), 'edited fixture\n')
      assert.equal(await fs.readFile(path.join(outside, 'new.txt'), 'utf8'), 'new fixture')
      await until(() => evaluate(`document.body.innerText.includes('DIRECTORY_FIXTURE_COMPLETE')`), 'final response')
      await fs.writeFile(path.join(run, 'completed.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'))
    } else {
      assert.equal(await fs.readFile(path.join(outside, 'fixture.txt'), 'utf8'), 'directory fixture\n')
      if (scenario === 'deny') {
        assert.equal(results[0].response.result?.isError, true, JSON.stringify(results))
        assert.match(JSON.stringify(results[0]), /denylist/)
      }
    }
    receipts.push({ scenario, packaged, approvalCards: seenCards, approvalEvents: events.length, toolCalls: results.length, rejectionStoppedTurn: mustAsk, ok: true })
  } catch (error) {
    await fs.writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), logs }, null, 2))
    console.error('Electron evidence:', run)
    throw error
  } finally {
    ws?.close(); child.kill('SIGTERM'); await delay(700)
    if (child.exitCode === null) child.kill('SIGKILL')
    await fs.writeFile(path.join(run, 'electron.log'), logs)
  }
}
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ root, baseline, receipts }, null, 2))
console.log(JSON.stringify({ root, baseline, receipts }))
