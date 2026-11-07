/** Real packaged Electron + UI/IPC/MCP/task storage; isolated fixture provider only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo = process.cwd(), evidence = process.env.EVIDENCE_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-unified-runtime-'))
await fs.mkdir(evidence, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-runtime-electron-')), data = path.join(root, 'data'), fake = path.join(root, 'codex-fixture'), trace = path.join(root, 'trace.jsonl'), stateFile = path.join(root, 'fixture-state.json')
const isolatedHome = path.join(root, 'home')
await fs.mkdir(path.join(isolatedHome, '.config'), { recursive: true })
await fs.mkdir(path.join(isolatedHome, '.cache'), { recursive: true })
await fs.mkdir(path.join(data, 'bots'), { recursive: true })
await fs.mkdir(path.join(data, 'sessions'), { recursive: true })
const executable = process.env.BLINKY_UNIFIED_EXECUTABLE || path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const packaged = !executable.includes('/node_modules/electron/')
let asarSha256
if (packaged) {
  asarSha256 = createHash('sha256').update(await fs.readFile(path.join(path.dirname(executable), '../Resources/app.asar'))).digest('hex')
  if (process.env.EXPECTED_ASAR_SHA) assert.equal(asarSha256, process.env.EXPECTED_ASAR_SHA)
}
await fs.writeFile(stateFile, '{}')
await fs.writeFile(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),readline=require('node:readline'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.167.0');process.exit()}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const config=args.find(x=>x.startsWith('mcp_servers.openbot='))||'',url=config.match(/url="([^"]+)"/)?.[1],key=config.match(/bearer_token_env_var="([^"]+)"/)?.[1];
const owner=process.ppid;setInterval(()=>{try{process.kill(owner,0)}catch{process.exit()}},200).unref();
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n'),record=(event,fields={})=>fs.appendFileSync(process.env.RUNTIME_TRACE,JSON.stringify({event,...fields})+'\n');
const readState=()=>JSON.parse(fs.readFileSync(process.env.RUNTIME_STATE,'utf8')),saveState=s=>fs.writeFileSync(process.env.RUNTIME_STATE,JSON.stringify(s));
let model='',thread='',turn='',n=0;
function finish(id,text,status='completed'){const item='answer-'+id;emit({method:'item/started',params:{threadId:thread,turnId:id,item:{type:'agentMessage',id:item,phase:'final_answer',text:''}}});if(text)emit({method:'item/agentMessage/delta',params:{threadId:thread,turnId:id,itemId:item,delta:text}});emit({method:'turn/completed',params:{threadId:thread,turn:{id,status,items:[]}}})}
function unwrap(text){const match=text.match(/<tool_result_data>\n([\s\S]*)\n<\/tool_result_data>/);return match?JSON.parse(match[1]).output:text}
async function call(name,arguments_,allowFailure=false){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env[key]},body:JSON.stringify({jsonrpc:'2.0',id:++n,method:'tools/call',params:{name,arguments:arguments_}})}),reply=await response.json();if(!response.ok||reply.error||reply.result?.isError){if(allowFailure)return {rejected:true};throw Error('fixture gateway invocation rejected: '+name)}const body=unwrap(reply.result.content.find(x=>x.type==='text')?.text||'');try{return JSON.parse(body)}catch{return body}}
async function taskCommand(action,task_id,extra={}){return call('manage_task',{action,task_id,...extra})}
async function newTask(label,prompt,key){const result=await call('delegate_task',{title:label,prompt}),id=String(result).match(/Task ID: ([a-zA-Z0-9-]+)/)?.[1];if(!id)throw Error('fixture missing task id');const s=readState();s[key]=id;saveState(s);record('delegated',{key});return id}
async function onStart(r){turn='turn-'+(++n);const current=turn,text=r.params.input?.[0]?.text||'';record('model_turn',{model});emit({id:r.id,result:{turn:{id:current}}});emit({method:'turn/started',params:{threadId:thread,turn:{id:current}}});
 if(!url){finish(current,'{}');return}
 if(model==='worker-model'){
  const label=text.includes('RESUME_FIXED')?'resume':text.includes('WORKER_CLARIFY_WAIT')?'clarify':text.includes('WORKER_RESTART_WAIT')?'restart':'cancel';record('worker_started',{label});
  if(label==='resume'){finish(current,'RESUME-CHECKED: prior effects inspected in this fixture.');return}
  if(label==='clarify'){
   const own=await taskCommand('list'),id=own.tasks[0]?.id;if(!id)throw Error('executor cannot inspect own task');
   const milestone=await taskCommand('report',id,{request_id:'fixture-milestone',text:'验收里程碑：已核对输入，等待补充信息。'});record('milestone',{delivered:milestone.receipt?.status==='delivered'});
   const duplicate=await taskCommand('report',id,{request_id:'fixture-milestone',text:'验收里程碑：已核对输入，等待补充信息。'});record('milestone_duplicate',{once:duplicate.duplicate===true});
   emit({id:'question-'+current,method:'item/tool/requestUserInput',params:{threadId:thread,turnId:current,itemId:'question-item',isBlocking:true,questions:[{id:'acceptance_label',header:'验收标签',question:'本次隔离验收应使用什么标签？'}]}});
  }return;
 }
 const agent=text.match(/<agent_result>([\s\S]*?)<\/agent_result>/);
 if(agent){const returned=JSON.parse(agent[1]),partial=String(returned.result).includes('PARTIAL-RESULT');await call('review_task',{task_id:returned.taskId,outcome:partial?'blocked':'complete_claimed',summary:partial?'执行器只返回部分结果，目标尚未完成。':'已对照本地恢复回执。',evidence:partial?[]:['The isolated executor returned its expected recovery marker.']});record('reviewed',{partial});finish(current,partial?'待核验：执行器只返回部分结果。':'恢复结果已核对。');return}
 const markers=['START_RUNTIME','SEND_SUPPLEMENT','FINISH_RUNTIME','START_CANCEL','STOP_CANCEL','START_RESTART','RESUME_CANCEL'],marker=markers.map(value=>({value,index:text.lastIndexOf(value)})).sort((a,b)=>b.index-a.index)[0];
 if(!marker||marker.index<0){finish(current,'状态已读取。');return}
 const s=readState();
 if(marker.value==='START_RUNTIME'){await newTask('Unified runtime clarification','WORKER_CLARIFY_WAIT','runtime');finish(current,'已开启隔离执行，主聊天保持可用。')}
 else if(marker.value==='SEND_SUPPLEMENT'){
  const first=await taskCommand('message',s.runtime,{request_id:'fixture-supplement',text:'SUPPLEMENT-FIXTURE'}),again=await taskCommand('message',s.runtime,{request_id:'fixture-supplement',text:'SUPPLEMENT-FIXTURE'}),inspect=await taskCommand('inspect',s.runtime),foreign=await call('manage_task',{action:'inspect',task_id:'foreign-task'},true);
  record('message_receipt',{delivered:first.receipt?.status==='delivered',duplicate:again.duplicate===true,running:inspect.task.status==='running',noReview:!inspect.task.review,foreignRejected:foreign.rejected===true});finish(current,'补充指令已有送达回执；目标仍在执行。')
 }else if(marker.value==='FINISH_RUNTIME'){await taskCommand('message',s.runtime,{request_id:'fixture-finish',text:'FINISH-FIXTURE'});finish(current,'执行器正在返回，尚未验收完成。')}
 else if(marker.value==='START_CANCEL'){await newTask('Unified runtime cancellation','WORKER_CANCEL_WAIT','cancel');finish(current,'取消验收任务已开始。')}
 else if(marker.value==='STOP_CANCEL'){const stopped=await taskCommand('stop',s.cancel);record('stopped',{cancelled:stopped.stopped===true});finish(current,'任务已停止；不会自动重跑。')}
 else if(marker.value==='START_RESTART'){await newTask('Unified runtime restart','WORKER_RESTART_WAIT','restart');finish(current,'重启恢复验收任务已开始。')}
 else if(marker.value==='RESUME_CANCEL'){const resumed=await taskCommand('resume',s.cancel,{text:'RESUME_FIXED: inspect previous actual effects first; resume only the isolated fixture.'});record('resumed',{sameSession:resumed.sameSession===true});finish(current,'已按明确指令在原执行会话安全续接。')}
}
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const r=JSON.parse(line);
 if(!r.method&&String(r.id).startsWith('question-')){record('clarification_answer',{correct:r.result?.answers?.acceptance_label?.answers?.[0]==='UNIFIED-ANSWER'});return}
 if(r.method==='initialize')emit({id:r.id,result:{}});
 else if(r.method==='model/list')emit({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'},{model:'worker-model',displayName:'Worker'}],nextCursor:null}});
 else if(r.method==='thread/start'||r.method==='thread/resume'){model=r.params.model||model;thread='fixture-'+model;emit({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:thread}}})}
 else if(r.method==='turn/start')await onStart(r);
 else if(r.method==='turn/steer'){emit({id:r.id,result:{turnId:turn}});const text=r.params.input?.[0]?.text||'';record('native_steer',{supplement:text.includes('SUPPLEMENT-FIXTURE'),finish:text.includes('FINISH-FIXTURE')});if(text.includes('FINISH-FIXTURE'))setTimeout(()=>{finish(turn,'PARTIAL-RESULT: fixture work still has an external blocker.');const probe=setInterval(async()=>{let s;try{s=readState()}catch{return}if(!s.cancel)return;clearInterval(probe);const result=await call('manage_task',{action:'inspect',task_id:s.cancel},true);record('terminal_executor_scope',{siblingRejected:result.rejected===true})},50);probe.unref()},150)}
 else if(r.method==='turn/interrupt'){emit({id:r.id,result:{}});record('native_interrupt');finish(turn,'','interrupted')}
 }catch{record('fixture_error');process.exitCode=1}});
`)
await fs.chmod(fake, 0o700)
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'light', defaultMode: 'agent', defaultBackendId: 'codex', defaultModelId: 'lead-model', memoryExtraction: 'off', approvalPolicy: 'auto-run', backends: { codex: { enabled: true, command: fake, extraArgs: [] } } }))
await fs.writeFile(path.join(data, 'bots', 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Runtime fixture', activeConversationId: 'fixture-home', systemPrompt: 'Follow the isolated fixture user command.', emoji: '✨', color: '#7c9cff', backendId: 'codex', modelId: 'lead-model', followsDefault: false, executionAgent: { backendId: 'codex', modelId: 'worker-model' }, tools: ['delegate_task'], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 }))
await fs.writeFile(path.join(data, 'sessions', 'fixture-home.json'), JSON.stringify({ id: 'fixture-home', title: 'Isolated runtime', botIds: ['fixture'], activeBotId: 'fixture', mode: 'agent', cwd: root, messages: [], todos: [], createdAt: 1, updatedAt: 1 }))
await fs.writeFile(path.join(data, 'gmail-drafts.json'), JSON.stringify([{ id: 'fixture-gmail-draft', sessionId: 'fixture-home', botId: 'fixture', receiverBotId: 'fixture', senderAccount: 'sender@example.test', to: 'recipient@example.test', subject: 'No credentials; never send externally', body: 'Isolated authorization UI fixture.', status: 'draft', createdAt: 1, updatedAt: 1 }]))
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
let app, ws, seq = 0, logs = '', home, observed = []
const launches = []
const pending = new Map()
function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIALS|SSH_AUTH_SOCK)/i.test(key)))
  const argv = [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`, '--remote-allow-origins=*']
  app = spawn(executable, argv, { cwd: repo, env: { ...env, HOME: isolatedHome, XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), XDG_CACHE_HOME: path.join(isolatedHome, '.cache'), BLINKY_SMOKE: '1', BLINKY_SMOKE_DIR: data, OPENBOT_DATA_DIR: data, RUNTIME_TRACE: trace, RUNTIME_STATE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  launches.push({ pid: app.pid, executable, argv, cwd: repo, userData: data, home: isolatedHome, launchedAt: new Date().toISOString() })
  app.stdout.on('data', value => { logs += value }); app.stderr.on('data', value => { logs += value })
}
function send(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('Inspector request timed out')) }, 12_000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error('Isolated runtime evaluation failed'); return result.result.value }
async function wait(expression, timeout = 30_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(80) } throw Error('The expected isolated runtime boundary was not reached: ' + expression.slice(0, 180)) }
async function connect() {
  let target
  for (let i = 0; i < 300; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === 'page'); if (target) break } catch {} if (app.exitCode !== null) throw Error('Isolated app exited before UI readiness'); await delay(100) }
  if (!target) throw Error('The isolated packaged renderer was not available')
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => { const value = JSON.parse(event.data), item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error('Inspector rejected request')) : item.resolve(value.result) }
  await wait('Boolean(window.openbot && document.querySelector("#ob-prompt"))')
  home = await evaluate('window.openbot.bots.list().then(bs=>bs.find(b=>b.id==="fixture").activeConversationId)')
}
async function command(text) {
  await wait(`window.openbot.agent.isRunning(${JSON.stringify(home)}).then(value=>!value)`)
  assert.equal(await evaluate(`window.openbot.agent.send(${JSON.stringify(home)},${JSON.stringify(text)})`), true)
  await wait(`window.openbot.agent.isRunning(${JSON.stringify(home)}).then(value=>!value)`)
}
async function tasks() { return evaluate('window.openbot.tasks.list()') }
async function snapshot(name) { const result = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, `${name}.png`), Buffer.from(result.data, 'base64')) }
async function visibleNotice(text) {
  const selector = `Array.from(document.querySelectorAll('.ob-application-notice')).find(e=>e.textContent.includes(${JSON.stringify(text)}))`
  await wait(`Boolean(${selector})`)
  await evaluate(`(${selector}).scrollIntoView({block:'center'})`)
  await wait(`(()=>{const e=${selector};if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'})()`)
}
async function stop() { ws?.close(); if (app && app.exitCode === null && app.signalCode === null) { app.kill('SIGTERM'); for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await delay(100); if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL') } }
async function events() { return (await fs.readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) }
try {
  launch(); await connect()
  await wait('Boolean(document.querySelector("[aria-label=\\"Gmail 邮件草稿\\"]"))')
  const turnsBeforeGmail = (await events()).filter(value => value.event === 'model_turn').length
  await command('发送这封草稿')
  await wait(`window.openbot.sessions.get(${JSON.stringify(home)}).then(s=>s.messages.some(m=>m.uiOnly&&(m.content.includes("这次发送未完成")||m.content.includes("请先在当前 Bot"))))`)
  const localReceipt = await evaluate(`window.openbot.sessions.get(${JSON.stringify(home)}).then(s=>s.messages.find(m=>m.uiOnly&&(m.content.includes("这次发送未完成")||m.content.includes("请先在当前 Bot"))).content)`)
  await visibleNotice(localReceipt)
  assert.equal((await events()).filter(value => value.event === 'model_turn').length, turnsBeforeGmail)
  assert.equal((await evaluate(`window.openbot.gmailDrafts.list(${JSON.stringify(home)})`)).drafts[0].status, 'draft')
  assert.equal(await evaluate(`window.openbot.agent.isRunning(${JSON.stringify(home)})`), false)
  await snapshot('gmail-command-without-credentials')
  await command('START_RUNTIME')
  await visibleNotice('已派发后台任务')
  await wait('window.openbot.tasks.clarifications().then(qs=>qs.some(q=>q.status==="waiting_user"))')
  await wait('Boolean(document.querySelector(".ob-task-clarification form"))')
  assert.equal(await evaluate('Boolean(document.querySelector("#ob-prompt")?.disabled)'), false)
  await evaluate('document.querySelector(".ob-task-clarification button[type=submit]").click()')
  await wait('Boolean(document.querySelector(".ob-task-clarification [aria-invalid=true]"))')
  await snapshot('waiting-clarification')
  const invalid = await evaluate('window.openbot.tasks.clarifications().then(qs=>window.openbot.tasks.answerClarification(qs.find(q=>q.status==="waiting_user").id,{}))')
  assert.equal(invalid.ok, false)
  await evaluate('(()=>{const input=document.querySelector(".ob-task-clarification textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"UNIFIED-ANSWER");input.dispatchEvent(new Event("input",{bubbles:true}));})()')
  await evaluate('document.querySelector(".ob-task-clarification button[type=submit]").click()')
  await wait('window.openbot.tasks.clarifications().then(qs=>qs.some(q=>q.status==="answered"&&q.answeredBy==="user"))')
  await command('SEND_SUPPLEMENT')
  let task = (await tasks()).find(value => value.title === 'Unified runtime clarification')
  assert.equal(task.status, 'running'); assert.equal(task.review, undefined)
  await command('FINISH_RUNTIME')
  await wait('window.openbot.tasks.list().then(ts=>ts.some(t=>t.title==="Unified runtime clarification"&&t.deliveryStatus==="delivered"))')
  task = (await tasks()).find(value => value.title === 'Unified runtime clarification')
  assert.equal(task.review?.outcome, 'blocked')
  await snapshot('partial-result-not-complete')
  await command('START_CANCEL'); await command('STOP_CANCEL')
  const cancelled = (await tasks()).find(value => value.title === 'Unified runtime cancellation')
  assert.equal(cancelled.status, 'cancelled')
  await command('START_RESTART')
  await wait('window.openbot.tasks.list().then(ts=>ts.some(t=>t.title==="Unified runtime restart"&&t.status==="running"))')
  const startsBefore = (await events()).filter(value => value.event === 'worker_started').length
  await stop(); launch(); await connect()
  await wait('window.openbot.tasks.list().then(ts=>ts.some(t=>t.title==="Unified runtime restart"&&["failed","cancelled"].includes(t.status)&&t.deliveryStatus==="uncertain"))')
  await delay(500)
  assert.equal((await events()).filter(value => value.event === 'worker_started').length, startsBefore)
  assert.equal((await tasks()).find(value => value.id === cancelled.id).status, 'cancelled')
  const resumeCommand = command('RESUME_CANCEL')
  await wait('Boolean(Array.from(document.querySelectorAll(".ob-approval-summary")).find(e=>e.textContent.includes("恢复任务")))')
  assert.equal((await tasks()).some(value => value.continuedFromTaskId === cancelled.id), false)
  await snapshot('resume-requires-confirmation')
  await delay(450)
  await evaluate('document.querySelector(".ob-approval .ob-btn-primary").click()')
  await resumeCommand
  await wait('window.openbot.tasks.list().then(ts=>ts.some(t=>t.continuedFromTaskId&&t.deliveryStatus==="delivered"))')
  const finalTasks = await tasks(), resumed = finalTasks.find(value => value.continuedFromTaskId === cancelled.id)
  assert.equal(resumed.sessionId, cancelled.sessionId)
  assert.equal(finalTasks.find(value => value.id === cancelled.id).status, 'cancelled')
  observed = await events()
  assert.ok(observed.some(value => value.event === 'message_receipt' && value.delivered && value.duplicate && value.running && value.noReview && value.foreignRejected))
  assert.equal(observed.filter(value => value.event === 'native_steer' && value.supplement).length, 1)
  assert.ok(observed.some(value => value.event === 'clarification_answer' && value.correct))
  assert.ok(observed.some(value => value.event === 'milestone' && value.delivered))
  assert.ok(observed.some(value => value.event === 'milestone_duplicate' && value.once))
  assert.ok(observed.some(value => value.event === 'terminal_executor_scope' && value.siblingRejected))
  assert.equal(observed.some(value => value.event === 'fixture_error'), false)
  const result = { ok: true, packaged, asarSha256, executable, dataRoot: data, provider: 'isolated protocol fixture; no real service call', checks: { applicationReceiptsVisibleInViewport: true, dispatchNoticeVisibleInViewport: true, trustedGmailCommandConsumedLocally: true, gmailWithoutCredentialsDoesNotSend: true, actualMcpTools: true, ownTaskScope: true, terminalExecutorScopeRemainsRestricted: true, liveReceiptNotCompletion: true, duplicateMessageOnce: true, reverseMilestone: true, interactiveClarification: true, invalidAnswerRejected: true, partialResultBlocked: true, cancellationPreserved: true, cancelledResumeRequiresUserApproval: true, explicitResumeSameSession: true, restartDoesNotReplay: true, composerRemainsAvailable: true }, taskCounts: Object.fromEntries(['running', 'queued', 'completed', 'failed', 'cancelled'].map(status => [status, finalTasks.filter(value => value.status === status).length])) }
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); await fs.writeFile(path.join(evidence, 'protocol-events.json'), JSON.stringify(observed, null, 2)); console.log(JSON.stringify(result))
} catch (error) {
  await fs.writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ ok: false, error: error.message, dataRoot: data, packaged, asarSha256 }, null, 2));
  try { await snapshot('failure') } catch {}
  throw error
} finally {
  await stop()
  await fs.writeFile(path.join(evidence, 'launches.json'), JSON.stringify(launches, null, 2))
  await fs.writeFile(path.join(evidence, 'app.log'), logs, { mode: 0o600 })
}
