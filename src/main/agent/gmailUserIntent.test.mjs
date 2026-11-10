import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function until(predicate) { for (let i=0;i<200;i++) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)) } throw Error('Expected isolated send boundary was not reached') }
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'blinky-gmail-user-intent-')),previous=process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR=root
  const state={drafts:[],sends:0,durableAtClaim:[],events:[],flushFails:false,beforeClaim:null,network:null,generation:0}
  globalThis.__gmailIntent=state
  const mocks={
    '../connectors/gmailDrafts': `export const listGmailDrafts=async id=>globalThis.__gmailIntent.drafts.filter(d=>d.sessionId===id).map(d=>({...d}));export async function actOnGmailDraft(id,sessionId,action,beforeClaim){const s=globalThis.__gmailIntent;if(s.beforeClaim)await s.beforeClaim;const d=s.drafts.find(d=>d.id===id&&d.sessionId===sessionId);if(!d||d.status!=='draft'||beforeClaim?.({...d})===false)throw Error('not available');s.durableAtClaim.push(s.isDurable());d.status='sending';d.updatedAt++;s.sends++;if(s.network)await s.network;d.status=s.uncertain?'uncertain':'sent';d.updatedAt++;return{...d}}`,
    '../store/jsonStore': `export const flushAll=async()=>({failed:globalThis.__gmailIntent.flushFails?['fixture']:[],stillWriting:false})`,
    '../ipc/broadcast': 'export const broadcast=e=>globalThis.__gmailIntent.events.push(e);export const postActivity=()=>{}'
    ,'./messageQueueRuntime': 'export const queueSuspensionGeneration=()=>globalThis.__gmailIntent.generation'
  }
  const outfile=join(root,'fixture.mjs')
  await build({stdin:{contents:`export * from './gmailUserIntent.ts';export * from '../store/sessions.ts';export * from '../store/bots.ts';export {flushAll as actualFlush} from '../store/jsonWrite.ts';`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile,plugins:[{name:'safe-boundaries',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})
  const api=await import(pathToFileURL(outfile).href)
  await api.loadSessions();const bot=api.createBot({name:'Owner',backendId:'codex',modelId:'fixture',followsDefault:false}),source=api.createSession([bot.id]);api.saveSession({...source,mode:'agent',cwd:root})
  const sessionId=source.id,windowId=7
  state.isDurable=()=>{const message=api.getSession(sessionId)?.messages.filter(m=>m.role==='user').at(-1);return message&&api.isSessionMessageDurable(sessionId,message.id)}
  function draft(id='draft-1'){const d={id,sessionId,botId:bot.id,receiverBotId:bot.id,senderAccount:'sender@example.test',to:'recipient@example.test',subject:'Isolated draft',body:'Only a fixture.',status:'draft',createdAt:1,updatedAt:1};state.drafts.push(d);return d}
  const consume=(text='发送这封草稿',attachments=[],sender=windowId)=>api.consumeGmailUserIntent(sender,sessionId,text,attachments)
  return{api,state,bot,sessionId,windowId,draft,consume,async close(){await until(()=>!state.drafts.some(d=>d.status==='sending'));await api.actualFlush();process.env.OPENBOT_DATA_DIR=previous;if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;await rm(root,{recursive:true,force:true})}}
}

test('only anchored attachment-free intent is eligible; quote/body/model-like text is not authorization',async()=>{
 const f=await fixture();try{
  for(const text of ['发送','发送这封草稿。','send this draft!','SEND THIS EMAIL'])assert.equal(f.api.isExactGmailSendIntent(text,[]),true)
  for(const text of ['帮我发送','邮件正文：发送','"发送"','发送并保存授权','Do not send this draft','发送这封草稿，然后删除记录'])assert.equal((await f.consume(text)).consumed,false)
  assert.equal((await f.consume('发送',[{id:'image',kind:'image',name:'fixture',mime:'image/png',data:'aGVsbG8='}])).consumed,false)
  assert.equal(f.api.getSession(f.sessionId).messages.filter(m=>m.role==='user').length,0);assert.equal(f.state.sends,0)
 }finally{await f.close()}
})
test('a backend draft is insufficient: same-window exact revision must have been presented',async()=>{
 const f=await fixture();try{
  const d=f.draft();assert.equal((await f.consume()).consumed,true);assert.equal(f.state.sends,0)
  assert.equal(await f.api.markGmailDraftPresented(f.windowId,d.id,f.sessionId,d.updatedAt+1),false)
  assert.equal(await f.api.markGmailDraftPresented(f.windowId+1,d.id,f.sessionId,d.updatedAt),true)
  await f.consume();assert.equal(f.state.sends,0)
  assert.equal(await f.api.markGmailDraftPresented(f.windowId,d.id,f.sessionId,d.updatedAt),true)
  d.body='Changed after presentation';d.updatedAt++
  await f.consume();assert.equal(f.state.sends,0)
 }finally{await f.close()}
})
test('durable user command precedes one send claim and network completion never holds the chat request',async()=>{
 const f=await fixture();let release;f.state.network=new Promise(resolve=>{release=resolve})
 try{
  const d=f.draft();await f.api.markGmailDraftPresented(f.windowId,d.id,f.sessionId,d.updatedAt)
  const accepted=await f.consume();assert.equal(accepted.accepted,true)
  assert.equal(f.state.sends,1);assert.deepEqual(f.state.durableAtClaim,[true]);assert.equal(d.status,'sending')
  await f.consume();assert.equal(f.state.sends,1)
  release();await until(()=>d.status==='sent')
  await f.consume();assert.equal(f.state.sends,1)
  assert.ok(f.api.getSession(f.sessionId).messages.some(m=>m.uiOnly&&m.content.includes('不会自动重发')))
 }finally{release();await f.close()}
})
test('zero/ambiguous/cancelled/uncertain/foreign drafts consume locally and never send or invoke a model',async()=>{
 const f=await fixture();try{
  await f.consume();const a=f.draft(),b=f.draft('draft-2');await f.api.markGmailDraftPresented(f.windowId,b.id,f.sessionId,b.updatedAt)
  await f.consume();assert.equal(f.state.sends,0)
  a.status='cancelled';b.status='uncertain';await f.consume();assert.equal(f.state.sends,0)
  b.status='draft';b.receiverBotId='other-bot';await f.consume();assert.equal(f.state.sends,0)
  assert.equal(f.api.getSession(f.sessionId).messages.filter(m=>m.role==='user').length,4)
 }finally{await f.close()}
})
test('persistence failure and identity change during asynchronous claim prevent the external action',async()=>{
 const f=await fixture();let release;try{
  const d=f.draft();await f.api.markGmailDraftPresented(f.windowId,d.id,f.sessionId,d.updatedAt)
  f.state.flushFails=true;assert.equal((await f.consume()).accepted,false);assert.equal(f.state.sends,0)
  f.state.flushFails=false;f.state.beforeClaim=new Promise(resolve=>{release=resolve})
  assert.equal((await f.consume()).accepted,true)
  const other=f.api.createBot({name:'Different',backendId:'codex',modelId:'fixture'}),source=f.api.getSession(f.sessionId)
  f.api.saveSession({...source,botIds:[f.bot.id,other.id],activeBotId:other.id});release()
  await until(()=>f.api.getSession(f.sessionId).messages.some(m=>m.uiOnly&&m.content.includes('这次发送未完成')))
  assert.equal(f.state.sends,0);assert.equal(d.status,'draft')
 }finally{release?.();await f.close()}
})
test('an explicit stop or pause before the network claim invalidates the accepted command without sending',async()=>{
 const f=await fixture();let release;try{
  const d=f.draft();await f.api.markGmailDraftPresented(f.windowId,d.id,f.sessionId,d.updatedAt)
  f.state.beforeClaim=new Promise(resolve=>{release=resolve})
  assert.equal((await f.consume()).accepted,true)
  f.state.generation++;release()
  await until(()=>f.api.getSession(f.sessionId).messages.some(m=>m.uiOnly&&m.content.includes('这次发送未完成')))
  assert.equal(f.state.sends,0);assert.equal(d.status,'draft')
 }finally{release?.();await f.close()}
})
