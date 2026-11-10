/** Mounted Preview, real UI/IPC/tools; synthetic OAuth, services, CLI and encryption only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'
import { connectInspector } from './inspect-installed-app.mjs'

const executable = process.env.BLINKY_CONNECTORS_EXECUTABLE
assert.ok(executable?.startsWith('/Volumes/'), 'Specify the read-only mounted Preview executable')
const bundle = executable.slice(0, executable.indexOf('.app/') + 4), asar = path.join(bundle, 'Contents/Resources/app.asar')
assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).blinkyBuildChannel, 'preview')
const sha256 = createHash('sha256').update(await fs.readFile(asar)).digest('hex')
assert.equal(sha256, process.env.BLINKY_CONNECTORS_ASAR_SHA, 'Bind the test to the coordinator-frozen ASAR')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-unified-connectors-')), data = path.join(root, 'data')
const evidence = process.env.BLINKY_CONNECTORS_EVIDENCE ?? path.join(root, 'evidence')
const env = await connectionTestEnvironment(root), trace = path.join(root, 'service-trace.jsonl'), cliTrace = path.join(root, 'cli-trace.jsonl')
const accountControl = path.join(root, 'account-control.json')
await fs.writeFile(accountControl, '{}')
const fake = path.join(root, 'fixture-codex.cjs'), botId = 'fixture-connector-bot', sessionId = 'fixture-connector-home'
await Promise.all([fs.mkdir(path.join(data, 'bots'), { recursive: true }), fs.mkdir(path.join(data, 'sessions'), { recursive: true }), fs.mkdir(evidence, { recursive: true })])
await fs.writeFile(path.join(root, 'bin', 'gh'), '#!/bin/sh\nprintf "not logged in\\n" >&2\nexit 1\n', { mode: 0o700 })
await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),readline=require('node:readline');let n=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),args=process.argv.slice(2);
fs.appendFileSync(process.env.CONNECTOR_CLI_TRACE,JSON.stringify({fixtureProcess:{pid:process.pid,ppid:process.ppid,executable:process.execPath,script:process.argv[1]}})+'\n');
if(args.includes('--version')){console.log('codex-cli 0.167.0');process.exit()}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const cfg=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',gateway=cfg.match(/url="([^"]+)"/)?.[1],key=cfg.match(/bearer_token_env_var="([^"]+)"/)?.[1];
readline.createInterface({input:process.stdin}).on('line',async line=>{try{
 const r=JSON.parse(line),p=r.params||{};
 fs.appendFileSync(process.env.CONNECTOR_CLI_TRACE,JSON.stringify({protocol:{method:r.method,requestTag:((p.input||[]).map(item=>item.text||'').join('\n').split('</conversation-so-far>').at(-1).match(/CONNECTOR_[A-Z_]+/g)||[]).at(-1),expectedTurnId:p.expectedTurnId}})+'\n');
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'fixture-lead',displayName:'Fixture Lead'}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:'connector-fixture'},approvalPolicy:p.approvalPolicy??'on-request',approvalsReviewer:p.approvalsReviewer??'auto_review',sandbox:{type:p.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false}}});
 else if(r.method==='turn/start'){
  const id='fixture-turn-'+(++n),text=(p.input||[]).map(item=>item.text||'').join('\n');send({id:r.id,result:{turn:{id}}});send({method:'turn/started',params:{threadId:'connector-fixture',turn:{id}}});
  const request=text.split('</conversation-so-far>').at(-1),tag=(request.match(/CONNECTOR_[A-Z_]+/g)||[]).at(-1);let tool,arguments_,output='Fixture receipt observed';
  const selected=JSON.parse(fs.readFileSync(process.env.CONNECTOR_ACCOUNT_CONTROL,'utf8'));
  if(tag==='CONNECTOR_ACCOUNTS'){tool='list_google_accounts';arguments_={service:'gmail'}}
  else if(tag==='CONNECTOR_SEARCH'||tag==='CONNECTOR_DENIED_SEARCH'||tag?.startsWith('CONNECTOR_ACCOUNT_SEARCH_')){tool='search_gmail';arguments_={query:'subject:Fixture',limit:2,...(tag?.startsWith('CONNECTOR_ACCOUNT_')?{account_id:selected.accountId}:{})}}
  else if(tag==='CONNECTOR_READ'){tool='read_gmail';arguments_={message_id:'fixture-mail'}}
  else if(tag?.startsWith('CONNECTOR_DRAFT_')){tool='gmail_draft';arguments_={to:tag==='CONNECTOR_DRAFT_RULE_MISS'?'other-recipient@example.test':'recipient@example.test',subject:tag,body:'Synthetic body; no real email.'}}
  if(tool){
   const response=await fetch(gateway,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[key]},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:arguments_}})});
   const result=await response.json(),ok=response.ok&&!result.error&&!result.result?.isError;
   const resultText=JSON.stringify(result);
   fs.appendFileSync(process.env.CONNECTOR_CLI_TRACE,JSON.stringify({tag,tool,ok,fixtureBody:resultText.includes('Fixture body'),fixtureSubject:resultText.includes('Fixture subject'),accountIds:[...new Set(resultText.match(/g_[a-f0-9]{24}/g)||[])],requestedAccount:selected.accountId,expectedIdentity:!selected.email||resultText.includes(selected.email)})+'\n');
   output=tag+' '+(ok?'PASS':'DENIED');
  }
  send({method:'item/started',params:{threadId:'connector-fixture',item:{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:''}}});
  send({method:'item/agentMessage/delta',params:{threadId:'connector-fixture',itemId:'answer-'+id,delta:output}});
  send({method:'turn/completed',params:{threadId:'connector-fixture',turn:{id,status:'completed'}}});
 }else if(r.id)send({id:r.id,result:{}})
}catch(error){fs.appendFileSync(process.env.CONNECTOR_CLI_TRACE,JSON.stringify({fixtureError:error.message})+'\n')}})
`)
await fs.chmod(fake, 0o700)
const backends = Object.fromEntries(['codex','claude','kimi','grok','pi','droid','opencode','openai','anthropic','openrouter','xai'].map(id => [id, { enabled: id === 'codex', command: fake, extraArgs: [] }]))
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'fixture-lead', defaultMode: 'agent', approvalPolicy: 'auto-run', memoryExtraction: 'off', runRoutinesWhenClosed: false, runInBackground: false, notifications: false, notifyOnComplete: false, backends }))
await fs.writeFile(path.join(data, 'bots', botId + '.json'), JSON.stringify({ id: botId, name: 'Connector Fixture', backendId: 'codex', modelId: 'fixture-lead', followsDefault: false, systemPrompt: 'Synthetic test only.', tools: ['search_gmail','read_gmail','gmail_draft'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: sessionId, createdAt: 1, updatedAt: 1 }))
await fs.writeFile(path.join(data, 'sessions', sessionId + '.json'), JSON.stringify({ id: sessionId, title: 'Connector fixture', botIds: [botId], activeBotId: botId, cwd: root, mode: 'agent', messages: [], todos: [], archived: false, createdAt: 1, updatedAt: 1 }))
Object.assign(env, { OPENBOT_DATA_DIR: data, BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, BLINKY_GOOGLE_CLIENT_ID: '123456789-fixture.apps.googleusercontent.com', BLINKY_X_CLIENT_ID: 'fixture-native-x-client', BLINKY_SLACK_CLIENT_ID: '123456.789012', CONNECTOR_CLI_TRACE: cliTrace, CONNECTOR_ACCOUNT_CONTROL: accountControl, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' })

// Runs before the package's entry point. Only fixture state leaves this context.
function installFixture(trace) {
  const req = process.getBuiltinModule('module').createRequire(process.execPath), electron = req('electron'), fs = req('node:fs')
  const originalFetch = globalThis.fetch
  const fixture = globalThis.__connectorFixture = { sends: 0, denied: false, consentDenied: false, failedSend: false, opened: 0, unexpected: [], dialogs: [], googleGrants: new Map(), loginEmail: 'sender@example.test', presented: [], holdRefresh: false, refreshWaiting: false }
  const log = value => fs.appendFileSync(trace, JSON.stringify(value) + '\n')
  const handle = electron.ipcMain.handle.bind(electron.ipcMain)
  electron.ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    const value = await listener(event, ...args)
    if (channel === 'openbot:gmail-drafts:presented') { const record = { id: args[0], sessionId: args[1], updatedAt: args[2], ok: value === true }; fixture.presented.push(record); log({ presented: record }) }
    if (channel === 'openbot:apps:disconnectGoogle') log({ disconnectedGoogle: { service: args[0], accountId: args[1], ok: value?.ok === true } })
    return value
  })
  for (const [key, value] of Object.entries({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from('FIXTURE:' + [...value].reverse().join('')), decryptString: bytes => { const value = bytes.toString(); if (!value.startsWith('FIXTURE:')) throw Error('Non-fixture secret refused'); return [...value.slice(8)].reverse().join('') } })) Object.defineProperty(electron.safeStorage, key, { configurable: true, value })
  electron.dialog.showErrorBox = (title) => { fixture.dialogs.push(title); log({ dialog: title }) }
  electron.shell.openExternal = async value => {
    const url = new URL(value), redirect = url.searchParams.get('redirect_uri')
    if (!redirect || !['accounts.google.com', 'x.com', 'slack.com'].includes(url.hostname)) { fixture.unexpected.push('external-open'); throw Error('Unexpected external link refused') }
    fixture.opened++; log({ oauth: url.hostname, pkce: url.searchParams.get('code_challenge_method') === 'S256', state: !!url.searchParams.get('state'), google: url.hostname === 'accounts.google.com', scopes: url.searchParams.get('scope') || url.searchParams.get('user_scope') })
    fixture.scopes = url.searchParams.get('scope'); fixture.slackScopes = url.searchParams.get('user_scope'); fixture.challenge = url.searchParams.get('code_challenge')
    const code = 'fixture-code-' + fixture.opened
    if (url.hostname === 'accounts.google.com') fixture.googleGrants.set(code, { email: fixture.loginEmail, scopes: fixture.scopes, challenge: fixture.challenge, denied: fixture.consentDenied })
    const callback = new URL(redirect); callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', code)
    assertLoopback(callback)
    if (!(await originalFetch(callback)).ok) throw Error('Fixture OAuth callback was refused')
  }
  function assertLoopback(url) { if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname)) throw Error('Only loopback callbacks allowed') }
  function validateExchange(body) {
    if (!body?.get('code')) return
    const challenge = req('node:crypto').createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
    if (challenge !== fixture.challenge) throw Error('Fixture provider rejected the PKCE verifier')
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), body = init?.body
    if (url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)) return originalFetch(input, init)
    if (url.href === 'https://oauth2.googleapis.com/token') {
      validateExchange(body)
      const grant = fixture.googleGrants.get(body?.get('code'))
      const email = grant?.email ?? Buffer.from((body?.get('refresh_token') ?? '').replace('fixture-google-refresh-', ''), 'base64url').toString()
      if (!/^(?:sender|account[234])@example\.test$/.test(email)) throw Error('Non-fixture Google identity refused')
      if (!grant && fixture.holdRefresh) { fixture.refreshWaiting = true; await new Promise(resolve => { fixture.releaseRefresh = resolve }) }
      const scope = grant?.denied || fixture.denied ? 'openid email' : grant?.scopes ?? 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events'
      const encoded = Buffer.from(email).toString('base64url')
      return Response.json({ access_token: 'fixture-google-access-' + encoded, refresh_token: 'fixture-google-refresh-' + encoded, scope, expires_in: 3600 })
    }
    const googleEmail = () => Buffer.from(String(init?.headers?.authorization ?? '').replace('Bearer fixture-google-access-', ''), 'base64url').toString()
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: googleEmail(), email_verified: true })
    if (url.hostname === 'gmail.googleapis.com') {
      if (fixture.denied) return new Response('', { status: 403 })
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: googleEmail() })
      if (url.pathname.endsWith('/messages/send')) { fixture.sends++; log({ send: 'gmail', count: fixture.sends, account: googleEmail() }); return fixture.failedSend ? new Response('', { status: 500 }) : Response.json({ id: 'fixture-message-' + fixture.sends }) }
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'fixture-mail' }] })
      if (url.pathname.endsWith('/messages/fixture-mail')) return Response.json({ id: 'fixture-mail', threadId: 'fixture-thread', snippet: 'Fixture preview', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Fixture subject ' + googleEmail() }], body: { data: Buffer.from('Fixture body ' + googleEmail()).toString('base64url') } } })
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/calendar/v3/calendars/primary/events') return Response.json({ items: [] })
    if (url.href === 'https://api.x.com/2/oauth2/token') { validateExchange(body); return Response.json({ access_token: 'fixture-x-access', refresh_token: 'fixture-x-refresh', scope: 'tweet.read tweet.write users.read offline.access', expires_in: 3600 }) }
    if (url.href === 'https://api.x.com/2/users/me') return Response.json({ data: { id: '123', username: 'fixture' } })
    if (url.hostname === 'slack.com' && url.pathname === '/api/oauth.v2.access') { validateExchange(body); return Response.json({ ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', token_type: 'user', access_token: 'xoxe.xoxp-fixture-access', refresh_token: 'fixture-slack-refresh', scope: fixture.slackScopes, expires_in: 3600 } }) }
    if (url.hostname === 'slack.com' && url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' })
    if (url.hostname === 'slack.com' && url.pathname === '/api/conversations.info') return Response.json({ ok: true, channel: { id: 'C123', is_member: true } })
    fixture.unexpected.push(url.origin + url.pathname); throw Error('Unexpected network request refused')
  }
  void electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel: true })))
  return { syntheticEncryption: true, systemBrowserBlocked: true, providerNetworkMocked: true }
}

const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
let app, main, ui, logs = '', errors = [], launchCount = 0
const result = { realElectron: true, packagedPreview: true, sha256, root, evidence, actualOAuth: false, actualAccount: false, realKeychain: false, realSend: false, checks: [], launches: [] }
async function launch() {
  const mainPort = await freePort(), uiPort = await freePort(); launchCount++
  const args = ['--inspect-brk=127.0.0.1:' + mainPort, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + uiPort, '--user-data-dir=' + path.join(root, 'chromium')]
  app = spawn(executable, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] })
  result.launches.push({ pid: app.pid, executable, args, cwd: root, startedAt: new Date().toISOString() })
  writeFileSync(path.join(evidence, 'launches.json'), JSON.stringify(result.launches, null, 2) + '\n')
  const capture = value => { logs += value; appendFileSync(path.join(evidence, 'application-live.log'), value) }
  app.stdout.on('data', capture); app.stderr.on('data', capture)
  main = await connectInspector(mainPort)
  await main.send('Debugger.enable')
  const paused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(Error('Preview did not stop at its entry breakpoint')) }, 10000)
    const off = main.on(event => { if (event.method === 'Debugger.paused') { clearTimeout(timer); off(); resolve(event.params.callFrames[0].callFrameId) } })
  })
  await main.send('Runtime.runIfWaitingForDebugger')
  const installed = await main.send('Debugger.evaluateOnCallFrame', { callFrameId: await paused, expression: `(${installFixture.toString()})(${JSON.stringify(trace)})`, returnByValue: true })
  assert.equal(installed.exceptionDetails, undefined, 'Fixture injection must succeed before any application code runs')
  assert.equal(installed.result?.value?.providerNetworkMocked, true)
  await main.send('Debugger.resume'); await main.send('Debugger.disable')
  ui = await connectInspector(uiPort, 'page')
  await ui.send('Runtime.enable')
  ui.on(event => { if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text) })
  await wait(`!!document.querySelector('#ob-prompt')`)
  const runtime = await main.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return{pid:process.pid,appPath:e.app.getAppPath(),userData:e.app.getPath('userData'),isPackaged:e.app.isPackaged}})()`)
  assert.equal(runtime.appPath, asar); assert.equal(runtime.userData, data); assert.equal(runtime.isPackaged, true)
  result.runtime = runtime
}
async function stop() {
  if (!app || app.exitCode !== null || app.signalCode !== null) return
  try { await main?.evaluate(`(()=>{setTimeout(()=>process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit(),0);return true})()`) } catch {}
  main?.close(); ui?.close()
  for (let i = 0; i < 60 && app.exitCode === null && app.signalCode === null; i++) await delay(100)
  if (app.exitCode === null && app.signalCode === null) { app.kill('SIGTERM'); await delay(500) }
  if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
}
async function wait(expression, timeout = 25000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await ui.evaluate(expression)) return; if (app.exitCode !== null || app.signalCode !== null) throw Error('Preview exited before check'); await delay(100) }
  throw Error('Timed out: ' + expression)
}
const click = async expression => { assert.equal(await ui.evaluate(`(()=>{const e=${expression};if(!e||e.disabled)return false;e.click();return true})()`), true) }
const setInput = async (selector, value) => ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(${selector === '#ob-prompt' ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
async function openApps() { await click(`document.querySelector('.ob-side-profile')`); await click(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='应用')`); await wait(`!!document.querySelector('[data-app=gmail]')`) }
async function closeApps() { await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(`!document.querySelector('[data-apps]')`) }
const cardButton = (service, text) => `[...document.querySelectorAll('[data-app="${service}"] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
async function sendUser(text) {
  const userIds = () => {
    const database = new DatabaseSync(path.join(data, 'sessions.sqlite'), { readOnly: true })
    try { return database.prepare('SELECT id,value FROM messages WHERE session_id=?').all(sessionId).filter(row => { const message = JSON.parse(row.value); return message.role === 'user' && !message.internal && message.content === text }).map(row => row.id) }
    finally { database.close() }
  }
  const before = new Set(userIds())
  await setInput('#ob-prompt', text)
  // Native setters update the DOM before React commits canSend. Do not race
  // that render with an immediate synthetic keydown and call it a user send.
  await wait(`document.querySelector('#ob-prompt')?.value===${JSON.stringify(text)}&&document.querySelector('button[aria-label="发送"]')?.disabled===false`)
  await ui.evaluate(`document.querySelector('#ob-prompt').focus()`)
  await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(`document.querySelector('#ob-prompt')?.value===''`)
  const until = Date.now() + 15000
  while (Date.now() < until) {
    const id = userIds().find(value => !before.has(value))
    if (id) { appendFileSync(path.join(evidence, 'user-admissions.jsonl'), JSON.stringify({ id, text, sqliteReadback: true }) + '\n'); return }
    await delay(50)
  }
  throw Error('User request did not reach durable SQLite: ' + text)
}
async function prompt(text) { await sendUser(text); await wait(`document.querySelector('.ob-transcript')?.textContent.includes(${JSON.stringify(text + ' PASS')}) || document.querySelector('.ob-transcript')?.textContent.includes(${JSON.stringify(text + ' DENIED')})`, 45000) }
async function waitMain(expression, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await main.evaluate(expression)) return; await delay(50) } throw Error('Main fixture timed out: ' + expression) }
async function presentedDraft(tag) {
  const card = `[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].find(e=>e.textContent.includes(${JSON.stringify(tag)}))`
  const id = await ui.evaluate(`(()=>{const e=${card};e.scrollIntoView({block:'center'});return e.dataset.gmailDraftId})()`)
  await waitMain(`__connectorFixture.presented.some(item=>item.id===${JSON.stringify(id)}&&item.ok)`)
  return id
}
async function screenshot(name) { const shot = await ui.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64')) }
const lines = async file => (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  await launch(); await openApps()
  assert.equal(await ui.evaluate(`['git','calendar','slack'].every(id=>!document.querySelector('[data-app="'+id+'"]')) && ['github','gmail','x'].every(id=>!!document.querySelector('[data-app="'+id+'"]'))`), true)
  await wait(`document.querySelector('[data-app=gmail]')?.textContent.includes('浏览器登录')`)
  await click(cardButton('gmail', '浏览器登录')); await wait(`document.querySelector('[data-app=gmail]')?.textContent.includes('已连接')`)
  await click(cardButton('x', '浏览器登录')); await wait(`document.querySelector('[data-app=x]')?.textContent.includes('已连接')`)
  assert.equal(await ui.evaluate(`window.openbot.apps.status().then(rows=>rows.filter(r=>['gmail','x'].includes(r.id)).every(r=>r.status==='connected'))`), true)
  assert.equal(await ui.evaluate(`window.openbot.apps.status().then(rows=>rows.filter(r=>['calendar','slack'].includes(r.id)).every(r=>r.status!=='connected'))`), true)
  for (const [index, email] of ['account2@example.test','account3@example.test','account4@example.test'].entries()) {
    await main.evaluate(`__connectorFixture.loginEmail=${JSON.stringify(email)}`)
    await click(cardButton('gmail', '添加其他账号'))
    await wait(`window.openbot.apps.status().then(rows=>rows.find(r=>r.id==='gmail')?.accounts?.length===${index + 2})`)
  }
  const fixtureAccounts = await ui.evaluate(`window.openbot.apps.status().then(rows=>rows.find(r=>r.id==='gmail').accounts)`)
  assert.equal(fixtureAccounts.length, 4); assert.equal(fixtureAccounts.find(value => value.isDefault).label, 'sender@example.test')
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="Gmail 账户"]').options.length`), 4)
  await main.evaluate(`__connectorFixture.loginEmail='sender@example.test'`)
  result.checks.push('Four simultaneous Gmail accounts added through real UI/OAuth without replacing the legacy default')
  await screenshot('connected-light'); result.checks.push('Gmail/X real UI+IPC PKCE callbacks, mocked providers; Calendar and Slack stay hidden')
  await ui.evaluate(`window.openbot.settings.update({theme:'dark'})`)
  await main.evaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0].setSize(760,620)`)
  await delay(150)
  assert.equal(await ui.evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`), true)
  assert.equal(await ui.evaluate(`/fixture-google-refresh|fixture-x-access|xoxe\\.xoxp-fixture-access/.test(document.body.innerText)`), false)
  await screenshot('connected-dark-compact'); result.checks.push('Dark compact apps layout, no credential values in visible UI')
  await main.evaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows()[0].setSize(1200,820)`)
  await ui.evaluate(`window.openbot.settings.update({theme:'light'})`)
  await main.evaluate(`__connectorFixture.consentDenied=true`)
  await click(cardButton('gmail', '重新授权默认账户')); await wait(`document.querySelector('[data-app=gmail] [role=alert]')?.textContent.includes('授权未完成')`)
  await main.evaluate(`__connectorFixture.consentDenied=false`)
  result.checks.push('Insufficient consent does not overwrite the working grant')
  await closeApps(); await prompt('CONNECTOR_ACCOUNTS')
  assert.equal((await lines(cliTrace)).find(row => row.tag === 'CONNECTOR_ACCOUNTS')?.accountIds.length, 4)
  for (const [index, account] of fixtureAccounts.entries()) {
    const tag = 'CONNECTOR_ACCOUNT_SEARCH_' + ['ONE','TWO','THREE','FOUR'][index]
    await fs.writeFile(accountControl, JSON.stringify({ accountId: account.id, email: account.label }))
    await prompt(tag)
    assert.ok((await lines(cliTrace)).some(row => row.tag === tag && row.ok && row.expectedIdentity))
  }
  const removedAccount = fixtureAccounts.find(value => value.label === 'account4@example.test')
  await openApps()
  await ui.evaluate(`(()=>{const e=document.querySelector('[aria-label="Gmail 账户"]');e.value=${JSON.stringify(removedAccount.id)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await click(cardButton('gmail', '断开此账户')); await click(cardButton('gmail', '确认断开'))
  await wait(`window.openbot.apps.status().then(rows=>rows.find(r=>r.id==='gmail')?.accounts?.length===3)`)
  await closeApps(); await fs.writeFile(accountControl, JSON.stringify({ accountId: removedAccount.id, email: removedAccount.label })); await prompt('CONNECTOR_ACCOUNT_SEARCH_REMOVED')
  assert.ok((await lines(cliTrace)).some(row => row.tag === 'CONNECTOR_ACCOUNT_SEARCH_REMOVED' && !row.ok))
  await fs.writeFile(accountControl, '{}'); result.checks.push('Real model metadata/service grant, four account-specific mailbox tools and single-account disconnect without fallback')
  await prompt('CONNECTOR_SEARCH'); await prompt('CONNECTOR_READ')
  const toolReads = await lines(cliTrace)
  assert.ok(toolReads.some(row => row.tool === 'search_gmail' && row.ok && row.fixtureSubject))
  assert.ok(toolReads.some(row => row.tool === 'read_gmail' && row.ok && row.fixtureBody))
  result.checks.push('Actual packaged tools search/read fixture mail through MCP')
  await prompt('CONNECTOR_DRAFT_CANCEL')
  assert.equal((await lines(trace)).filter(row => row.send).length, 0)
  await click(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].find(e=>e.textContent.includes('CONNECTOR_DRAFT_CANCEL')).querySelector('button')`)
  await wait(`document.querySelector('[aria-label="Gmail 邮件草稿"]')?.textContent.includes('邮件已取消')`)
  await prompt('CONNECTOR_DRAFT_SEND')
  await click(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].find(e=>e.textContent.includes('CONNECTOR_DRAFT_SEND')).querySelectorAll('button')[1]`)
  await wait(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].some(e=>e.textContent.includes('Gmail 已接收发送请求'))`)
  assert.equal((await lines(trace)).filter(row => row.send).length, 1)
  await main.evaluate(`__connectorFixture.failedSend=true`)
  await prompt('CONNECTOR_DRAFT_FAILURE')
  await click(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].find(e=>e.textContent.includes('CONNECTOR_DRAFT_FAILURE')).querySelectorAll('button')[1]`)
  await wait(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].some(e=>e.textContent.includes('发送结果未确认'))`)
  assert.equal((await lines(trace)).filter(row => row.send).length, 2)
  await screenshot('drafts-light'); result.checks.push('No early send, cancellation, one confirmed mock send, failed send stays uncertain')
  await main.evaluate(`__connectorFixture.failedSend=false`)
  await prompt('CONNECTOR_DRAFT_DIRECT'); const directId = await presentedDraft('CONNECTOR_DRAFT_DIRECT')
  await sendUser('发送这封草稿')
  await wait(`window.openbot.gmailDrafts.list(${JSON.stringify(sessionId)}).then(r=>r.drafts?.some(d=>d.id===${JSON.stringify(directId)}&&d.status==='sent'&&d.remoteId))`)
  assert.equal((await lines(trace)).filter(row => row.send).length, 3)
  await sendUser('发送这封草稿'); await wait(`document.body.innerText.includes('已有发送结果未确认') || document.body.innerText.includes('当前没有可发送的草稿')`)
  assert.equal((await lines(trace)).filter(row => row.send).length, 3)
  result.checks.push('Viewport observer acknowledgment plus exact conversational consent sends once; duplicate consent does not replay')
  let expectedSends = 3
  if (process.env.BLINKY_CONNECTORS_SEND_RULES === '1') {
    assert.equal(await ui.evaluate(`typeof window.openbot.sendRules?.list`), 'function')
    assert.deepEqual(await ui.evaluate(`window.openbot.sendRules.list().then(r=>r.rules)`), [])
    await main.evaluate(`__connectorFixture.failedSend=false`)
    await prompt('CONNECTOR_DRAFT_RULE_SAVE')
    const ruleCard = `[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].find(e=>e.textContent.includes('CONNECTOR_DRAFT_RULE_SAVE'))`
    assert.equal(await ui.evaluate(`${ruleCard}.querySelector('input[type=checkbox]')`), null)
    assert.equal(await ui.evaluate(`${ruleCard}.textContent.includes('已使用你保存的精确收件人发送规则') || ${ruleCard}.textContent.includes('确认发送并保存规则')`), false)
    await click(`${ruleCard}.querySelector('.ob-btn-primary')`)
    await wait(`${ruleCard}.textContent.includes('Gmail 已接收发送请求')`)
    assert.deepEqual(await ui.evaluate(`window.openbot.sendRules.list().then(r=>r.rules)`), [])
    assert.equal((await lines(trace)).filter(row => row.send).length, 4)
    expectedSends = 4
    await screenshot('send-rules-light'); result.checks.push('Retired send rules do not auto-send; confirming one draft sends only that draft')
  }
  const expectedDraftCount = await ui.evaluate(`document.querySelectorAll('[aria-label="Gmail 邮件草稿"]').length`)
  assert.deepEqual(await main.evaluate(`({unexpected:__connectorFixture.unexpected,dialogs:__connectorFixture.dialogs})`), { unexpected: [], dialogs: [] })
  await stop(); await launch()
  await wait(`document.querySelectorAll('[aria-label="Gmail 邮件草稿"]').length===${expectedDraftCount}`)
  assert.equal((await lines(trace)).filter(row => row.send).length, expectedSends)
  assert.ok(await ui.evaluate(`[...document.querySelectorAll('[aria-label="Gmail 邮件草稿"]')].some(e=>e.textContent.includes('发送结果未确认'))`))
  result.checks.push('Fresh process preserves drafts/connection and never retries uncertain send')
  await main.evaluate(`__connectorFixture.holdRefresh=true`)
  await prompt('CONNECTOR_DRAFT_STOP'); const stoppedId = await presentedDraft('CONNECTOR_DRAFT_STOP')
  await sendUser('发送这封草稿'); await waitMain(`__connectorFixture.refreshWaiting`)
  await ui.evaluate(`window.openbot.agent.stop(${JSON.stringify(sessionId)})`)
  await main.evaluate(`__connectorFixture.holdRefresh=false;__connectorFixture.releaseRefresh?.()`)
  await wait(`window.openbot.gmailDrafts.list(${JSON.stringify(sessionId)}).then(r=>r.drafts?.some(d=>d.id===${JSON.stringify(stoppedId)}&&d.status==='draft'&&d.sendNotStarted===true))`)
  assert.equal((await lines(trace)).filter(row => row.send).length, expectedSends)
  await click(`document.querySelector('[data-gmail-draft-id="${stoppedId}"] button')`)
  result.checks.push('Actual conversation send/CAS/token-refresh stop fence records zero POST and retains a non-replayed draft')
  // The fixture explicitly resumes its own queue before issuing new work;
  // stopping must not be silently undone merely by restarting the package.
  const resumedQueue = await ui.evaluate(`window.openbot.agent.pauseQueue(${JSON.stringify(sessionId)},false)`)
  assert.equal(resumedQueue?.sessionId, sessionId); assert.equal(resumedQueue.paused, false); assert.deepEqual(resumedQueue.items, [])
  // A separate process supplies a fresh access cache for the reduced-scope check.
  await stop(); await launch()
  await main.evaluate(`__connectorFixture.denied=true`)
  await openApps()
  await wait(`document.querySelector('[data-app=gmail]')?.textContent.includes('无法验证连接')`)
  await screenshot('permission-denied-light'); await closeApps(); await prompt('CONNECTOR_DENIED_SEARCH')
  assert.ok((await lines(cliTrace)).some(row => row.tag === 'CONNECTOR_DENIED_SEARCH' && row.ok === false))
  assert.equal((await lines(trace)).filter(row => row.send).length, expectedSends)
  result.checks.push('Reduced refreshed scopes surface unavailable status and deny the actual mail tool without a send')
  await openApps()
  for (const service of ['gmail']) {
    let remaining = await ui.evaluate(`window.openbot.apps.status().then(rows=>rows.find(r=>r.id===${JSON.stringify(service)})?.accounts?.length??0)`)
    while (remaining) {
      const accountIds = await ui.evaluate(`window.openbot.apps.status().then(rows=>(rows.find(r=>r.id===${JSON.stringify(service)})?.accounts??[]).map(account=>account.id))`)
      const picker = `[data-app="${service}"] .ob-google-account-picker select`
      // The backend count may update before SettingsApps commits its refresh.
      // Choose a target only from the actually rendered current account list.
      await wait(`(()=>{const e=document.querySelector(${JSON.stringify(picker)}),ids=${JSON.stringify(accountIds)};return e?.options.length===ids.length&&ids.includes(e.value)&&[...e.options].every(option=>ids.includes(option.value))})()`)
      const selectedAccountId = await ui.evaluate(`document.querySelector(${JSON.stringify(picker)}).value`)
      appendFileSync(path.join(evidence, 'disconnect-selections.jsonl'), JSON.stringify({ service, selectedAccountId, accountIds }) + '\n')
      await click(cardButton(service, '断开此账户')); await click(cardButton(service, '确认断开')); remaining--
      await wait(`window.openbot.apps.status().then(rows=>(rows.find(r=>r.id===${JSON.stringify(service)})?.accounts?.length??0)===${remaining})`)
      await wait(`(document.querySelector(${JSON.stringify(picker)})?.options.length??0)===${remaining}`)
    }
  }
  for (const service of ['x']) { await click(cardButton(service, '断开')); await click(cardButton(service, '确认断开')); await wait(`document.querySelector('[data-app="${service}"]')?.textContent.includes('未连接')`) }
  await screenshot('disconnected-light'); await closeApps()
  // Change the prompt marker without reusing a previous visible success.
  await ui.evaluate(`window.__connectorDenied=window.openbot.apps.status().then(rows=>rows.filter(r=>['gmail','x'].includes(r.id)).every(r=>r.status==='disconnected'))`)
  assert.equal(await ui.evaluate(`window.__connectorDenied`), true)
  await stop(); await launch(); await openApps()
  assert.equal(await ui.evaluate(`window.openbot.apps.status().then(rows=>rows.filter(r=>['gmail','x'].includes(r.id)).every(r=>r.status==='disconnected'&&!(r.accounts?.length)))`), true)
  assert.equal(await ui.evaluate(`['git','calendar','slack'].every(id=>!document.querySelector('[data-app="'+id+'"]'))`), true)
  assert.equal((await lines(trace)).filter(row => row.send).length, expectedSends)
  result.checks.push('Disconnect persists across a second fresh process; no authorization or send replay')
  result.fixtureTrace = await lines(trace); result.toolTrace = await lines(cliTrace)
  assert.ok(result.fixtureTrace.filter(row => row.oauth).every(row => row.pkce && row.state))
  assert.deepEqual(await main.evaluate(`({unexpected:__connectorFixture.unexpected,dialogs:__connectorFixture.dialogs})`), { unexpected: [], dialogs: [] })
  assert.deepEqual(errors, []); result.ok = true
} catch (error) { result.ok = false; result.error = error.stack ?? String(error); if (ui) await screenshot('failure').catch(() => {}) }
finally {
  result.launchCount = launchCount; result.rendererErrors = errors
  await stop(); await fs.writeFile(path.join(evidence, 'application.log'), logs); await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ ok: result.ok, evidence, sha256, checks: result.checks, error: result.error }))
if (!result.ok) process.exitCode = 1
