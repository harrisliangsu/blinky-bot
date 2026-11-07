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
test('retired rules never auto-send; a trusted explicit confirmation still sends once',async()=>{
  await api.saveGmailSendRule('sender@example.test','target@example.test')
  const disk=await fs.readFile(path.join(process.env.OPENBOT_DATA_DIR,'outbound-send-rules.json'),'utf8')
  const draft=await api.createGmailDraft('home','bot',input('Explicit confirmation only'))
  assert.equal(draft.status,'draft');assert.equal(attempts,0)
  assert.equal((await invoke('openbot:send-rules:save-gmail-draft',[draft.id,'home'])).ok,false)
  assert.equal(await fs.readFile(path.join(process.env.OPENBOT_DATA_DIR,'outbound-send-rules.json'),'utf8'),disk)
  const sent=await invoke('openbot:gmail-drafts:act',[draft.id,'home','send']);assert.equal(sent.ok,true);assert.equal(sent.draft.status,'sent');assert.equal(attempts,1)
  await invoke('openbot:gmail-drafts:act',[draft.id,'home','send']);assert.equal(attempts,1)
  newRequest();const cancelled=await api.createGmailDraft('home','bot',input('Cancelled fixture'))
  await invoke('openbot:gmail-drafts:act',[cancelled.id,'home','cancel']);await invoke('openbot:gmail-drafts:act',[cancelled.id,'home','send']);assert.equal(attempts,1)
})
