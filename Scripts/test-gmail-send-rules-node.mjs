// Actual draft store, rule encryption boundary, Gmail provider and IPC handler.
// Session/Bot ownership and Electron window identity are synthetic boundaries.
// All network goes to a transport fixture; no credentials or real sends exist.
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-send-rules-node-'))
process.env.OPENBOT_DATA_DIR=path.join(root,'data');await fs.mkdir(process.env.OPENBOT_DATA_DIR)
after(()=>fs.rm(root,{recursive:true,force:true}))
const fixture=path.join(root,'fixture.mjs')
await fs.writeFile(fixture,`export const state={events:[],handlers:new Map(),sessions:new Map([['home',{id:'home',mode:'agent',archived:false,botIds:['bot'],activeBotId:'bot',messages:[{id:'request-1',role:'user',content:'Synthetic request'}]}]]),bots:new Map([['bot',{id:'bot',archived:false}]]),tasks:[],settings:{denylist:[],allowlist:[]}};
export const broadcast=e=>state.events.push(e),getSession=id=>state.sessions.get(id)??null,getBot=id=>state.bots.get(id)??null,listTasks=()=>state.tasks,getSettings=()=>state.settings,isBotBeingRemoved=id=>state.removingBot===id;
export const BrowserWindow={fromWebContents:sender=>sender.trusted?{}:null};export const ipcMain={removeHandler:name=>state.handlers.delete(name),handle:(name,fn)=>state.handlers.set(name,fn)};
export const registerNativeHandler=()=>{throw Error('Send rule IPC must not enter native stdio')};export const markGmailDraftPresented=async()=>true;
`)
const replacements=new Set(['src/main/agent/events','src/main/store/sessions','src/main/store/bots','src/main/store/tasks','src/main/tasks','src/main/settings','src/main/native/stdioBridge','src/main/agent/gmailUserIntent'].map(name=>path.join(repo,name)))
const bundle=await build({stdin:{contents:`export * from './src/main/connectors/gmailDrafts';export * from './src/main/connectors/sendRules';export * from './src/main/connectors/googleSecrets';export * from './src/main/connectors/googleOAuth';export {registerGmailDraftIpc} from './src/main/ipc/gmailDrafts';export {gmailDraftTool} from './src/main/tools/agent/gmailDraft';`,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'ownership-and-window-boundaries',setup(b){b.onResolve({filter:/.*/},a=>{if(a.path==='electron')return{path:fixture,external:true};if(a.path.startsWith('.')){const p=path.resolve(path.dirname(a.importer),a.path).replace(/\.ts$/,'');if(replacements.has(p))return{path:fixture,external:true}}})}}]})
const entry=path.join(root,'main.mjs');await fs.writeFile(entry,bundle.outputFiles[0].text)
let api=await import(pathToFileURL(entry).href)
const {state}=await import(pathToFileURL(fixture).href)
let onDecrypt,attempts=0,failSend=false,tokenGate
const storage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('synthetic-cipher:'+Buffer.from(value).toString('base64')),decryptString:value=>{const text=value.toString();if(!text.startsWith('synthetic-cipher:'))throw Error('Not synthetic ciphertext');const raw=Buffer.from(text.slice('synthetic-cipher:'.length),'base64').toString();if(raw.startsWith('['))onDecrypt?.();return raw}}
const scopes=['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']
const grant=account=>({clientId:'123456789-fixture.apps.googleusercontent.com',refreshToken:'synthetic-refresh-only',scopes,account})
function install(target){target.setGoogleStorageForTests(storage);target.setSendRuleStorageForTests(storage);target.setGoogleOAuthTransportForTests(async input=>{const url=String(input);if(url.endsWith('/token')){if(tokenGate){tokenGate.enter();await tokenGate.released}return Response.json({access_token:'synthetic-access-only',scope:scopes.join(' '),expires_in:3600})}if(url.endsWith('/messages/send')){attempts++;await new Promise(resolve=>setTimeout(resolve,10));return failSend?new Response('',{status:503}):Response.json({id:'synthetic-message-'+attempts})}throw Error('Unexpected network URL')})}
function pauseRefresh(){let enter,release;const entered=new Promise(r=>enter=r),released=new Promise(r=>release=r);tokenGate={enter,released};api.invalidateGoogleAccessToken('gmail');return{entered,release:()=>{tokenGate=undefined;release()}}}
install(api);await api.saveGoogleCredentials('gmail',grant('sender@example.test'));api.registerGmailDraftIpc()
let user=1
function newRequest(){state.sessions.get('home').messages.push({id:'request-'+(++user),role:'user',content:'Synthetic new user request'})}
const input=(subject,to='target@example.test')=>({to,subject,body:'Synthetic body '+subject})
const invoke=(channel,args,trusted=true)=>state.handlers.get(channel)({sender:{id:10,trusted,mainFrame:{frameTreeNodeId:1}},senderFrame:{frameTreeNodeId:trusted?1:2}},...args)
let initial,rule

test('no saved rule stays local; only a trusted current draft can save the exact sender/recipient rule',async()=>{
  initial=await api.createGmailDraft('home','bot',input('Initial approval'))
  assert.equal(initial.status,'draft');assert.equal(attempts,0)
  assert.equal((await invoke('openbot:send-rules:save-gmail-draft',[initial.id,'home'],false)).ok,false)
  assert.deepEqual(await api.listSendRules(),[])
  const saved=await invoke('openbot:send-rules:save-gmail-draft',[initial.id,'home']);assert.equal(saved.ok,true);rule=saved.rule
  assert.deepEqual([rule.service,rule.senderAccount,rule.to],['gmail','sender@example.test','target@example.test'])
  assert.equal((await api.createGmailDraft('home','bot',input('Initial approval'))).id,initial.id)
  assert.equal(attempts,0,'adding a rule must not send an existing draft')
  const disk=await fs.readFile(path.join(process.env.OPENBOT_DATA_DIR,'outbound-send-rules.json'),'utf8');assert.equal(disk.includes(rule.to),false);assert.equal(disk.includes(rule.senderAccount),false)
})

test('matching new requests send exactly once, including concurrent model retries, and report provider acceptance honestly',async()=>{
  newRequest();const before=attempts
  const drafts=await Promise.all(Array.from({length:3},()=>api.createGmailDraft('home','bot',input('One send only'))))
  assert.equal(new Set(drafts.map(d=>d.id)).size,1);assert.equal(attempts,before+1)
  const sent=(await api.listGmailDrafts('home')).find(d=>d.id===drafts[0].id)
  assert.equal(sent.status,'sent');assert.equal(sent.sendAuthorization.ruleId,rule.id)
  const context={sessionId:'home',botId:'bot',signal:new AbortController().signal,host:{createGmailDraft:api.createGmailDraft}}
  const response=await api.gmailDraftTool.handler(input('One send only'),context)
  assert.equal(response.ok,true);assert.match(response.output,/Gmail accepted/);assert.doesNotMatch(response.output,/No email has been sent/);assert.equal(attempts,before+1)
})

test('uncertain and cancelled records never become automatic retries in the same trusted request',async()=>{
  newRequest();failSend=true;const before=attempts
  const uncertain=await api.createGmailDraft('home','bot',input('Uncertain send'));assert.equal(uncertain.status,'uncertain')
  failSend=false
  assert.equal((await api.createGmailDraft('home','bot',input('Uncertain send'))).id,uncertain.id);assert.equal(attempts,before+1)
  const response=await api.gmailDraftTool.handler(input('Uncertain send'),{sessionId:'home',botId:'bot',signal:new AbortController().signal,host:{createGmailDraft:api.createGmailDraft}})
  assert.equal(response.ok,false);assert.match(response.output,/uncertain.*do not retry/i)
  newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Uncertain send'))).status,'draft');assert.equal(attempts,before+1,'a later request needs a new confirmation for identical uncertain content')
  const cancelled=await api.actOnGmailDraft(initial.id,'home','cancel');assert.equal(cancelled.status,'cancelled')
  // Restore the original request scope without manufacturing a new user turn.
  const session=state.sessions.get('home'),messages=session.messages;session.messages=[messages[0]]
  assert.equal((await api.createGmailDraft('home','bot',input('Initial approval'))).status,'cancelled')
  session.messages=messages;assert.equal(attempts,before+1)
})

test('recipient aliases, sender mismatch, denied calls, missing scope and stopped requests do not auto-send',async()=>{
  const before=attempts
  for(const to of ['target+alias@example.test','tar.get@example.test','other@example.test']){newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Exact '+to,to))).status,'draft')}
  await api.saveGoogleCredentials('gmail',grant('another@example.test'));api.invalidateGoogleAccessToken('gmail');newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Wrong sender'))).status,'draft')
  await api.saveGoogleCredentials('gmail',grant('sender@example.test'));api.invalidateGoogleAccessToken('gmail')
  state.settings.denylist=['tool:gmail_draft'];newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Denied call'))).status,'draft');state.settings.denylist=[]
  const session=state.sessions.get('home'),messages=session.messages;session.messages=[];assert.equal((await api.createGmailDraft('home','bot',input('No trustworthy request'))).status,'draft');session.messages=messages
  const controller=new AbortController();controller.abort();newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Stopped request'),controller.signal)).status,'draft')
  await assert.rejects(api.createGmailDraft('home','bot',input('Multiple','target@example.test,other@example.test')),/one valid recipient/)
  assert.equal(attempts,before)
})

test('unreadable encryption or damaged rules fail back to a review draft without overwriting rules',async()=>{
  const before=attempts,ruleFile=path.join(process.env.OPENBOT_DATA_DIR,'outbound-send-rules.json'),saved=await fs.readFile(ruleFile)
  api.setSendRuleStorageForTests(null);newRequest();assert.equal((await api.createGmailDraft('home','bot',input('No system encryption'))).status,'draft');api.setSendRuleStorageForTests(storage)
  await fs.writeFile(ruleFile,'{damaged synthetic');newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Damaged rule store'))).status,'draft')
  assert.equal(await fs.readFile(ruleFile,'utf8'),'{damaged synthetic');await assert.rejects(api.listSendRules());await fs.writeFile(ruleFile,saved)
  assert.equal(attempts,before)
})

test('revocation and a deny rule changed during rule lookup still prevent a new send',async()=>{
  let before=attempts;await api.removeSendRule(rule.id);newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Revoked rule'))).status,'draft');assert.equal(attempts,before)
  rule=await api.saveGmailSendRule('sender@example.test','target@example.test')
  onDecrypt=()=>{state.settings.denylist=['tool:gmail_draft']};newRequest();assert.equal((await api.createGmailDraft('home','bot',input('Deny during lookup'))).status,'draft');onDecrypt=undefined;state.settings.denylist=[];assert.equal(attempts,before)
})

test('current running continuation owns the request scope; archived or changed manual send origins are refused',async()=>{
  const execution={id:'execution',mode:'agent',archived:true,botIds:['bot'],activeBotId:'bot',messages:[{id:'executor-prompt',role:'user',content:'Synthetic task'}]};state.sessions.set('execution',execution)
  state.tasks=[{id:'old',botId:'bot',sessionId:'execution',sourceSessionId:'home',status:'completed',createdAt:1},{id:'current',botId:'bot',sessionId:'execution',sourceSessionId:'home',status:'running',createdAt:2}]
  const sent=await api.createGmailDraft('execution','bot',input('Continuation scope'));assert.equal(sent.status,'sent');assert.equal(sent.requestScopeId,'task:current')
  state.tasks[1].status='completed';state.tasks.push({id:'continuation',continuedFromTaskId:'current',botId:'bot',sessionId:'execution',sourceSessionId:'home',status:'running',createdAt:3})
  const beforeContinuation=attempts,repeated=await api.createGmailDraft('execution','bot',input('Continuation scope'));assert.equal(repeated.id,sent.id);assert.equal(attempts,beforeContinuation);state.tasks=[]
  newRequest();const draft=await api.createGmailDraft('home','bot',input('Manual review','unmatched@example.test')),before=attempts
  await assert.rejects(api.actOnGmailDraft(draft.id,'home','send',()=>false),/authorization/)
  state.removingBot='bot';await assert.rejects(api.actOnGmailDraft(draft.id,'home','send'),/authorization/);state.removingBot=undefined
  state.sessions.get('home').archived=true;await assert.rejects(api.actOnGmailDraft(draft.id,'home','send'),/originating/);state.sessions.get('home').archived=false
  assert.equal((await api.listGmailDrafts('home')).find(d=>d.id===draft.id).status,'draft');assert.equal(attempts,before)
})

test('explicit account namespaces do not inherit default rules, cross accounts or fall back after disconnect',async()=>{
  const before=attempts,defaultId=api.googleAccountId('sender@example.test')
  newRequest();const explicitDefault=await api.createGmailDraft('home','bot',{...input('Explicit default namespace'),accountId:defaultId})
  assert.equal(explicitDefault.status,'draft');assert.equal(explicitDefault.accountId,defaultId);assert.equal(attempts,before)
  const extraId=await api.addGoogleCredentials('gmail',grant('extra@example.test'))
  newRequest();const extra=await api.createGmailDraft('home','bot',{...input('Extra account local'),accountId:extraId});assert.equal(extra.status,'draft');assert.equal(extra.senderAccount,'extra@example.test')
  const saved=await invoke('openbot:send-rules:save-gmail-draft',[extra.id,'home']);assert.equal(saved.ok,true);assert.equal(saved.rule.accountId,extraId)
  newRequest();const sent=await api.createGmailDraft('home','bot',{...input('Extra account authorized'),accountId:extraId});assert.equal(sent.status,'sent');assert.equal(sent.senderAccount,'extra@example.test');assert.equal(sent.sendAuthorization.ruleId,saved.rule.id)
  await api.removeGoogleCredentials('gmail',extraId);newRequest();await assert.rejects(api.createGmailDraft('home','bot',{...input('Disconnected extra'),accountId:extraId}),/not connected/)
  assert.equal((await api.readGoogleCredentials('gmail')).account,'sender@example.test')
})

test('stop, revocation, deny changes and Bot deletion during token refresh cause zero business POSTs',async()=>{
  const before=attempts
  newRequest();let gate=pauseRefresh();const controller=new AbortController(),stopped=api.createGmailDraft('home','bot',input('Stop during refresh'),controller.signal)
  await gate.entered;controller.abort();gate.release();const unsent=await stopped
  assert.equal(unsent.status,'draft');assert.equal(unsent.sendNotStarted,true);assert.equal(unsent.sendAuthorization,undefined)
  assert.equal((await api.createGmailDraft('home','bot',input('Stop during refresh'))).id,unsent.id);assert.equal(attempts,before)
  const response=await api.gmailDraftTool.handler(input('Stop during refresh'),{sessionId:'home',botId:'bot',signal:new AbortController().signal,host:{createGmailDraft:api.createGmailDraft}});assert.equal(response.ok,false);assert.match(response.output,/stopped before.*No email has been sent/)
  newRequest();gate=pauseRefresh();const revoked=api.createGmailDraft('home','bot',input('Revoke during refresh'))
  await gate.entered;await api.removeSendRule(rule.id);gate.release();assert.equal((await revoked).sendNotStarted,true);assert.equal(attempts,before)
  rule=await api.saveGmailSendRule('sender@example.test','target@example.test')
  newRequest();gate=pauseRefresh();const denied=api.createGmailDraft('home','bot',input('Deny during refresh'))
  await gate.entered;state.settings.denylist=['tool:gmail_draft'];gate.release();assert.equal((await denied).sendNotStarted,true);state.settings.denylist=[];assert.equal(attempts,before)
  newRequest();gate=pauseRefresh();const deleted=api.createGmailDraft('home','bot',input('Delete during refresh'))
  await gate.entered;state.removingBot='bot';gate.release();assert.equal((await deleted).sendNotStarted,true);state.removingBot=undefined;assert.equal(attempts,before)
  newRequest();const manual=await api.createGmailDraft('home','bot',input('Manual stop during refresh','manual@example.test'));let allowed=true
  gate=pauseRefresh();const sending=api.actOnGmailDraft(manual.id,'home','send',()=>true,()=>allowed)
  await gate.entered;allowed=false;gate.release();assert.equal((await sending).sendNotStarted,true);assert.equal(attempts,before)
})

test('process-style module recovery turns sending into uncertain and never replays it',async()=>{
  newRequest();const stopped=new AbortController();stopped.abort();const draft=await api.createGmailDraft('home','bot',input('Interrupted process'),stopped.signal)
  const draftFile=path.join(process.env.OPENBOT_DATA_DIR,'gmail-drafts.json'),records=JSON.parse(await fs.readFile(draftFile,'utf8'));records.find(d=>d.id===draft.id).status='sending';await fs.writeFile(draftFile,JSON.stringify(records))
  const restarted=path.join(root,'restarted.mjs');await fs.writeFile(restarted,bundle.outputFiles[0].text);api=await import(pathToFileURL(restarted).href);install(api)
  const before=attempts,recovered=await api.createGmailDraft('home','bot',input('Interrupted process'))
  assert.equal(recovered.id,draft.id);assert.equal(recovered.status,'uncertain');assert.equal(attempts,before)
  assert.equal(JSON.parse(await fs.readFile(draftFile,'utf8')).find(d=>d.id===draft.id).status,'uncertain')
})
