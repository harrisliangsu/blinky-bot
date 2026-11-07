/** Actual trusted-intent + draft CAS + SQLite/JSON; only Google transport/storage mocked. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('persisted local authorization reaches the real Gmail draft claim exactly once',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-gmail-local-claim-')),previous=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 let release;const network=new Promise(resolve=>{release=resolve}),state={calls:[],events:[],network,generation:0}
 globalThis.__gmailLocalClaim=state
 const mocks={
  './googleSecrets': 'export const readGoogleCredentials=async()=>({account:"sender@example.test",clientId:"fixture",refreshToken:"fixture-not-real",scopes:[]})',
  './googleOAuth': 'export class GoogleSendNotStartedError extends Error{};export const sendGmailRaw=async(raw,expected,accountId,beforePost)=>{const s=globalThis.__gmailLocalClaim;if(s.tokenGate){s.refreshWaiting=true;await s.tokenGate}if(beforePost?.()===false){s.deniedAtPost=true;throw new GoogleSendNotStartedError("stopped before POST")}s.calls.push({expected,accountId,durable:s.isDurable()});await s.network;return "fixture-remote-id"}',
  '../agent/events': 'export const broadcast=e=>globalThis.__gmailLocalClaim.events.push(e)',
  '../ipc/broadcast': 'export const broadcast=e=>globalThis.__gmailLocalClaim.events.push(e);export const postActivity=()=>{}',
  './messageQueueRuntime': 'export const queueSuspensionGeneration=()=>globalThis.__gmailLocalClaim.generation',
  '../tasks': 'export const isBotBeingRemoved=()=>false'
 }
 const outfile=join(root,'fixture.mjs')
 try{
  await build({stdin:{contents:`export * from './gmailUserIntent.ts';export * from '../connectors/gmailDrafts.ts';export * from '../store/bots.ts';export * from '../store/sessions.ts';export {flushAll} from '../store/jsonWrite.ts';`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile,plugins:[{name:'google-and-desktop-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
  const api=await import(pathToFileURL(outfile).href)
  await api.loadSessions();const bot=api.createBot({name:'Owner',backendId:'codex',modelId:'fixture',followsDefault:false}),source=api.createSession([bot.id])
  api.saveSession({...source,mode:'agent',cwd:root,messages:[{id:'prepare-message',role:'user',content:'Prepare a draft.',createdAt:1}]});await api.flushAll()
  state.isDurable=()=>{const m=api.getSession(source.id).messages.filter(m=>m.role==='user').at(-1);return m?.content==='发送这封草稿'&&api.isSessionMessageDurable(source.id,m.id)}
  const draft=await api.createGmailDraft(source.id,bot.id,{to:'recipient@example.test',subject:'Fixture',body:'No real message is sent.'})
  assert.equal(draft.status,'draft');assert.equal(state.calls.length,0)
  assert.equal(await api.markGmailDraftPresented(7,draft.id,source.id,draft.updatedAt),true)
  assert.equal((await api.consumeGmailUserIntent(7,source.id,'发送这封草稿',[])).accepted,true)
  for(let i=0;i<200&&state.calls.length===0;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].durable,true)
  const persisted=JSON.parse(await readFile(join(root,'gmail-drafts.json'),'utf8'))
  assert.equal(persisted[0].status,'sending')
  assert.equal((await api.consumeGmailUserIntent(7,source.id,'发送这封草稿',[])).accepted,true)
  assert.equal(state.calls.length,1)
  release()
  for(let i=0;i<200&&(await api.listGmailDrafts(source.id))[0].status!=='sent';i++)await new Promise(resolve=>setTimeout(resolve,5))
  const sent=(await api.listGmailDrafts(source.id))[0];assert.equal(sent.status,'sent');assert.equal(sent.remoteId,'fixture-remote-id')
  await assert.rejects(api.actOnGmailDraft(draft.id,source.id,'send'))
  await api.consumeGmailUserIntent(7,source.id,'发送这封草稿',[])
  assert.equal(state.calls.length,1)
  const second=await api.createGmailDraft(source.id,bot.id,{to:'recipient@example.test',subject:'After refresh',body:'Stop before the mail POST.'})
  assert.equal(await api.markGmailDraftPresented(7,second.id,source.id,second.updatedAt),true)
  let resumeRefresh;state.tokenGate=new Promise(resolve=>{resumeRefresh=resolve})
  assert.equal((await api.consumeGmailUserIntent(7,source.id,'发送这封草稿',[])).accepted,true)
  for(let i=0;i<200&&!state.refreshWaiting;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(state.refreshWaiting,true)
  assert.equal((await api.listGmailDrafts(source.id)).find(d=>d.id===second.id).status,'sending')
  state.generation++;resumeRefresh()
  for(let i=0;i<200&&(await api.listGmailDrafts(source.id)).find(d=>d.id===second.id).status==='sending';i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(state.deniedAtPost,true);assert.equal(state.calls.length,1)
  assert.equal((await api.listGmailDrafts(source.id)).find(d=>d.id===second.id).status,'draft')
  assert.equal((await api.listGmailDrafts(source.id)).find(d=>d.id===second.id).sendNotStarted,true)
  await api.flushAll()
 }finally{
  release();await new Promise(resolve=>setTimeout(resolve,20));process.env.OPENBOT_DATA_DIR=previous;if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;await rm(root,{recursive:true,force:true})
 }
})
