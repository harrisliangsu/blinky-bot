// Separate-process integration probe. Called only with a white-list test environment.
import assert from 'node:assert/strict'
import { app, session as electronSession } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadBots } from '../store/bots.ts'
import { loadSessions } from '../store/sessions.ts'
import { flushAll } from '../store/jsonStore.ts'
import { setGoogleStorageForTests, readGoogleCredentials } from './googleSecrets.ts'
import { setXStorageForTests, readXCredentials } from './xSecrets.ts'
import { setSlackStorageForTests, readSlackCredentials, clearSlackCredentials } from './slackSecrets.ts'
import { setGoogleOAuthTransportForTests, disconnectGoogle, invalidateGoogleAccessToken } from './googleOAuth.ts'
import { setXTransportForTests, disconnectX, invalidateXAccess } from './xOAuth.ts'
import { setSlackTransportForTests, invalidateSlackRequests } from './slackApi.ts'
import { setSlackOAuthTransportForTests } from './slackOAuth.ts'
import { restartSlackSocket, slackConnectionState, slackShouldStayAlive } from './slackSocket.ts'
import { searchGmailTool, listCalendarTool } from '../tools/agent/googleRead.ts'
import { readXTool } from '../tools/agent/x.ts'
import { slackDraftTool } from '../tools/agent/slackDraft.ts'
import { createSlackDraft, actOnSlackDraft, listSlackDrafts } from './slackDrafts.ts'
import { appStatuses, invalidateGoogleStatus, invalidateXStatus } from '../apps/status.ts'

if (process.platform === 'darwin') app.dock.hide()
electronSession.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_request,callback)=>callback({cancel:true}))
globalThis.fetch=async()=>{throw new Error('Unexpected unmocked network request in connector integration test.')}
assert.match(process.env.HOME ?? '', /blinky-restart-tools-.*\/home$/)
for (const key of ['GH_TOKEN','GITHUB_TOKEN','PRIVATE_SERVICE_TOKEN','HTTP_PROXY','HTTPS_PROXY','SSH_AUTH_SOCK','BLINKY_GOOGLE_CLIENT_ID','BLINKY_X_CLIENT_ID','BLINKY_SLACK_CLIENT_ID','BLINKY_GITHUB_CLIENT_ID','BLINKY_GITHUB_CLIENT_SECRET']) assert.equal(process.env[key], undefined)
const fixture = JSON.parse(await readFile(join(process.env.OPENBOT_DATA_DIR, 'test-context.json'), 'utf8'))
const phase = process.argv[2], denied = phase === 'denied'
const storage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from([...v].reverse().join('')), decryptString: v => [...v.toString()].reverse().join('') }
setGoogleStorageForTests(storage); setXStorageForTests(storage); setSlackStorageForTests(storage)
let sends = 0
setGoogleOAuthTransportForTests(async (input, init) => {
  const url = new URL(String(input))
  if (denied) return new Response('', {status:403})
  if (url.pathname === '/token') return Response.json({access_token:(init.body.get('refresh_token') === 'calendar-refresh' ? 'calendar-access' : 'gmail-access'),expires_in:3600})
  if (url.pathname === '/v1/userinfo') return Response.json({email:'fixture@example.test',email_verified:true})
  const header = init.headers.authorization
  if (url.pathname.includes('/gmail/')) assert.equal(header,'Bearer gmail-access')
  else assert.equal(header,'Bearer calendar-access')
  if (url.pathname.endsWith('/profile')) return Response.json({emailAddress:'fixture@example.test'})
  if (url.pathname.endsWith('/messages')) return Response.json({messages:[]})
  return Response.json({items:[{id:'fixture-event',summary:'Fixture',start:{dateTime:'2026-11-06T01:00:00Z'},end:{dateTime:'2026-11-06T02:00:00Z'}}]})
})
setXTransportForTests(async (input, init) => {
  if (denied) return new Response('',{status:403})
  const url=String(input)
  if(url.endsWith('/token'))return Response.json({access_token:'x-access',refresh_token:'x-rotated-refresh',expires_in:3600})
  assert.equal(init.headers.authorization,'Bearer x-access')
  if(url.endsWith('/users/me'))return Response.json({data:{id:'123',username:'fixture'}})
  return Response.json({data:{id:'456',text:'Fixture public post'}})
})
setSlackTransportForTests(async(input,init)=>{
  if(denied)return Response.json({ok:false,error:'missing_scope'})
  assert.equal(init.headers.authorization,'Bearer xoxe.xoxp-fixture-access')
  const method=String(input).split('/').at(-1)
  if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123'})
  if(method==='conversations.info')return Response.json({ok:true,channel:{id:'C123',is_member:true}})
  if(method==='chat.postMessage'){if(phase==='send-denied')return Response.json({ok:false,error:'missing_scope'});sends++;return Response.json({ok:true,channel:'C123',ts:'123.456'})}
  throw Error('Browser authorization must not open a Socket Mode connection')
})
setSlackOAuthTransportForTests(async()=>{
  if(denied)return Response.json({ok:false,error:'invalid_refresh_token'})
  return Response.json({ok:true,token_type:'user',access_token:'xoxe.xoxp-fixture-access',refresh_token:'fixture-new-refresh',expires_in:3600})
})
await loadBots(); await loadSessions()
const ctx={sessionId:fixture.sessionId,botId:fixture.botId,cwd:process.env.HOME,signal:new AbortController().signal,emit:()=>{},requestApproval:async()=>({decision:'deny'}),host:{createSlackDraft}}
if(phase==='disconnect'){
  await disconnectGoogle('gmail');await disconnectGoogle('calendar');await disconnectX();invalidateSlackRequests();await clearSlackCredentials()
}
await restartSlackSocket()
const results=await Promise.all([
  searchGmailTool.handler({query:'fixture'},ctx),
  listCalendarTool.handler({start:'2026-11-06T00:00:00Z',end:'2026-11-07T00:00:00Z'},ctx),
  readXTool.handler({post_id:'456'},ctx)
])
if(phase==='tools'){
  assert.ok(results.every(r=>r.ok));assert.equal(slackConnectionState().state,'connected');assert.equal(slackConnectionState().mode,'browser');assert.equal(slackShouldStayAlive(),false)
  const draft=await slackDraftTool.handler({text:'Fixture local draft only'},ctx);assert.equal(draft.ok,true);assert.equal(sends,0)
  const saved=(await listSlackDrafts(fixture.sessionId)).find(d=>d.id===draft.detail.draftId);assert.equal(saved.teamId,'T123');assert.equal(saved.slackBotUserId,'U123');assert.equal(saved.status,'draft')
  await actOnSlackDraft(saved.id,fixture.sessionId,'send');assert.equal(sends,1)
  const statuses=await appStatuses();for(const id of ['gmail','calendar','x','slack'])assert.equal(statuses.find(s=>s.id===id).status,'connected')
}else if(phase==='send-denied'){
  assert.ok(results.every(r=>r.ok))
  const draft=await slackDraftTool.handler({text:'Send permission failure fixture'},ctx);assert.equal(draft.ok,true)
  await actOnSlackDraft(draft.detail.draftId,fixture.sessionId,'send');assert.equal(sends,0)
  assert.equal(slackConnectionState().state,'error')
  assert.equal((await appStatuses()).find(s=>s.id==='slack').status,'unavailable')
}else if(phase==='denied'){
  assert.ok(results.every(r=>!r.ok));assert.equal(slackConnectionState().state,'error')
  invalidateGoogleStatus('gmail');invalidateGoogleStatus('calendar');invalidateXStatus()
  const statuses=await appStatuses();for(const id of ['gmail','calendar','x','slack'])assert.equal(statuses.find(s=>s.id===id).status,'unavailable')
  const draft=await slackDraftTool.handler({text:'Permission failure fixture'},ctx);assert.equal(draft.ok,true);await actOnSlackDraft(draft.detail.draftId,fixture.sessionId,'send');assert.equal(sends,0)
  assert.equal((await listSlackDrafts(fixture.sessionId)).find(d=>d.id===draft.detail.draftId).status,'uncertain')
}else{
  assert.ok(results.every(r=>!r.ok));assert.equal((await slackDraftTool.handler({text:'Disconnected fixture'},ctx)).ok,false)
  assert.equal(await readGoogleCredentials('gmail'),null);assert.equal(await readXCredentials(),null);assert.equal(await readSlackCredentials(),null)
  const statuses=await appStatuses();for(const id of ['gmail','calendar','x','slack'])assert.equal(statuses.find(s=>s.id===id).status,'disconnected')
}
await flushAll();invalidateGoogleAccessToken('gmail');invalidateGoogleAccessToken('calendar');invalidateXAccess();invalidateSlackRequests()
console.log(JSON.stringify({phase,toolResults:results.map(r=>r.ok),slackState:slackConnectionState().state,mockSends:sends,realNetwork:false}))
app.exit(0)
