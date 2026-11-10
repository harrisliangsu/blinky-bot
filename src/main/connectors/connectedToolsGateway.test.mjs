// Actual loopback MCP/registry/Google connector code with virtual identities.
// Store lookup, settings/approval surfaces, OS encryption and provider transport
// are fixtures. This is not a native CLI, Electron or real-provider test.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import Module from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const here=dirname(fileURLToPath(import.meta.url))
const fixture={bots:new Map(),sessions:new Map(),settings:{denylist:[],allowlist:[],approvalPolicy:'auto-run',language:'en',computerUse:false},approvals:0}
globalThis.__connectorPathFixture=fixture
const result=await build({stdin:{resolveDir:here,loader:'ts',contents:`
export {attachSession,detachSession} from '../gateway/index';
export {schemasFor,runTool} from '../tools/registry';
export {DEFAULT_BOT_TOOLS} from '../store/starterBots';
export {setExecutionAgent,bindExecutionAgent,clearExecutionAgent} from '../agent/executionAgent';
export {connectGoogle,disconnectGoogle,invalidateGoogleAccessToken,setGoogleOAuthTransportForTests} from './googleOAuth';
export {setGoogleStorageForTests,readGoogleCredentials,googleAccountId} from './googleSecrets';
export {captureAppToolIntent,finishAppToolIntent,invalidateAppToolIntent} from '../apps/toolAccess';
export {loadBots,createBot,getBot,setBotAppToolsDurable} from '../store/bots';
export {CONNECTED_APP_TOOLS} from '../../shared/connectedAppTools';
`},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',define:{'import.meta.glob':'fixtureGlob'},banner:{js:'const fixtureGlob=()=>({});'},plugins:[{name:'fixture-surfaces',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}))
  b.onResolve({filter:/store\/(bots|sessions)$/},a=>a.importer.includes('/gateway/')?{path:a.path.endsWith('bots')?'bots':'sessions',namespace:'fixture'}:undefined)
  b.onResolve({filter:/agent\/settingsGateway$/},a=>a.importer.endsWith('/gateway/invoke.ts')?{path:'settingsGateway',namespace:'fixture'}:undefined)
  b.onResolve({filter:/agent\/approval$/},a=>a.importer.endsWith('/gateway/invoke.ts')?{path:'approval',namespace:'fixture'}:undefined)
  b.onResolve({filter:/^\.\/host$/},a=>a.importer.endsWith('/gateway/invoke.ts')?{path:'host',namespace:'fixture'}:undefined)
  b.onResolve({filter:/apps\/status$/},a=>a.path==='../../apps/status'?{path:'status',namespace:'fixture'}:undefined)
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:({
    electron:'export const app={getVersion:()=>"fixture",isPackaged:false};export const safeStorage={};export const BrowserWindow={getAllWindows:()=>[]};export const shell={};export const Notification={};',
    bots:'export const getBot=id=>globalThis.__connectorPathFixture.bots.get(id);',
    sessions:'export const getSession=id=>globalThis.__connectorPathFixture.sessions.get(id);',
    settingsGateway:'export const settingsStore={get:async()=>globalThis.__connectorPathFixture.settings};',
    approval:'export const requestApproval=async()=>{globalThis.__connectorPathFixture.approvals++;return {approved:false,reason:"fixture refusal"}};',
    host:'export const gatewayHost={};',
    status:'export const googleAccountStatuses=async()=>[];'
  })[a.path],loader:'js'}))
}}]})
const compiled=new Module(join(here,'__gateway_fixture.cjs'));compiled.filename=join(here,'__gateway_fixture.cjs');compiled.paths=Module._nodeModulePaths(here);compiled._compile(result.outputFiles[0].text,compiled.filename)
const app=compiled.exports
const scopes=['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']
test('browser grant reaches Bot and independent Agent through real MCP tools with account and grant isolation', {timeout:20000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'blinky-connected-tools-'));process.env.OPENBOT_DATA_DIR=root
  app.setGoogleStorageForTests({isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from([...s].reverse().join('')),decryptString:b=>[...b.toString()].reverse().join('')})
  let grantName='A', challenge='', calls=0, posts=0, tokenExchanges=0, readsB=0
  app.setGoogleOAuthTransportForTests(async(input,init)=>{
    const url=String(input)
    if(url.endsWith('/token')){
      const body=init.body
      if(body.get('grant_type')==='authorization_code'){
        const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),challenge);tokenExchanges++
        return Response.json({access_token:`fixture-access-${grantName}`,refresh_token:`fixture-refresh-${grantName}`,scope:scopes.join(' '),expires_in:3600})
      }
      const name=body.get('refresh_token').endsWith('B')?'B':'A';return Response.json({access_token:`fixture-access-${name}`,expires_in:3600})
    }
    const name=init.headers.authorization.endsWith('B')?'B':'A'
    if(url.includes('userinfo'))return Response.json({email:`fixture-${name.toLowerCase()}@example.test`,email_verified:true})
    if(url.endsWith('/profile'))return Response.json({emailAddress:`fixture-${name.toLowerCase()}@example.test`})
    if(init.method==='POST'){posts++;throw Error('No business POST expected')}
    calls++
    if(url.includes('/messages?'))return Response.json({messages:[{id:'fixture_message',threadId:'fixture_thread'}]})
    if(url.includes('/messages/fixture_message')){
      if(name==='B' && ++readsB===1)return new Response('',{status:401})
      const format=new URL(url).searchParams.get('format')
      return Response.json({id:'fixture_message',snippet:`fixture ${name}`,payload:{mimeType:'text/html',headers:[{name:'Subject',value:`fixture ${name}`}],body:{data:Buffer.from(`<p>Mailbox ${name} &amp; readable</p><script>hidden()</script>`).toString('base64url')}}})
    }
    throw Error('Unexpected fixture endpoint')
  },async value=>{
    const url=new URL(value);challenge=url.searchParams.get('code_challenge');assert.equal(url.searchParams.get('code_challenge_method'),'S256')
    const callback=new URL(url.searchParams.get('redirect_uri'));callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','fixture-code');assert.equal((await fetch(callback)).status,200)
  })
  const tools=['delegate_task','search_gmail','read_gmail','gmail_draft','read_x_post','x_post_draft','slack_message_draft','github_comment_draft']
  const bot={id:'fixture-bot',name:'Fixture',backendId:'codex',modelId:'fixture',systemPrompt:'Fixture',tools,computerUse:false,executionAgent:{backendId:'codex',modelId:'fixture-executor'}}
  fixture.bots.set(bot.id,bot);for(const id of ['lead','worker','restricted'])fixture.sessions.set(id,{id,mode:'agent',botIds:[bot.id]})
  const attached=[]
  try{
    process.env.BLINKY_GOOGLE_CLIENT_ID='123456789-fixture.apps.googleusercontent.com'
    await app.connectGoogle('gmail')
    grantName='B';await app.connectGoogle('gmail','','',{addAccount:true});assert.equal(tokenExchanges,2)
    const idB=app.googleAccountId('fixture-b@example.test')
    // Default connection experience: no pre-grant. Real durable Bot store and
    // the same intent completed by the OAuth IPC handler, then real MCP calls.
    await app.loadBots()
    const selected=app.createBot({name:'Selected connection Bot',tools:['read_file','delegate_task'],executionAgent:{backendId:'codex',modelId:'fixture-executor'}})
    const unrelated=app.createBot({name:'Unrelated connection Bot',tools:['read_file']})
    const intent=app.captureAppToolIntent('gmail',selected.id)
    assert.ok(!app.getBot(selected.id).tools.includes('search_gmail'))
    const selectedWithTools=await app.finishAppToolIntent(intent)
    assert.ok(app.CONNECTED_APP_TOOLS.gmail.every(id=>selectedWithTools.tools.includes(id)))
    assert.ok(!app.getBot(unrelated.id).tools.includes('read_gmail'))
    fixture.bots.set(selected.id,selectedWithTools);fixture.bots.set(unrelated.id,app.getBot(unrelated.id))
    app.setExecutionAgent('default-agent',{backendId:'codex',modelId:'fixture-executor'},selected.id)
    const defaultAgent=app.bindExecutionAgent('default-agent',selectedWithTools)
    assert.ok(defaultAgent.tools.includes('read_gmail'));assert.ok(!defaultAgent.tools.includes('delegate_task'))
    for(const [id,b] of [['default-lead',selectedWithTools],['default-agent',selectedWithTools],['unrelated-lead',unrelated]]){
      fixture.sessions.set(id,{id,mode:'agent',botIds:[b.id]})
      const gateway=await app.attachSession({sessionId:id,botId:b.id,cwd:root,backendId:'codex'});assert.ok(gateway);attached.push(id)
      const response=await fetch(gateway.url,{method:'POST',headers:{authorization:`Bearer ${gateway.bearerToken}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_gmail',arguments:{query:'fixture',account_id:idB}}})})
      assert.equal(response.status,200);const value=await response.json()
      assert.notEqual(value.result.isError,true)
      assert.match(JSON.stringify(value),/fixture_message/)
    }
    await app.setBotAppToolsDurable(selected.id,app.CONNECTED_APP_TOOLS.gmail,false)
    assert.ok(!app.getBot(selected.id).tools.includes('read_gmail'));assert.ok(!app.getBot(unrelated.id).tools.includes('read_gmail'))
    const stale=app.captureAppToolIntent('gmail',selected.id);app.invalidateAppToolIntent('gmail')
    await assert.rejects(app.finishAppToolIntent(stale),/changed|available|connection/i)
    app.clearExecutionAgent('default-agent')
    app.setExecutionAgent('worker',bot.executionAgent,bot.id)
    const bound=app.bindExecutionAgent('worker',bot);assert.ok(!bound.tools.includes('delegate_task'));assert.ok(bound.tools.includes('read_gmail'))
    for(const sessionId of ['lead','worker']){
      const gateway=await app.attachSession({sessionId,botId:bot.id,cwd:root,backendId:'codex'});assert.ok(gateway);attached.push(sessionId)
      let sequence=0, mcpSession
      const rpc=async(method,params={})=>{
        const response=await fetch(gateway.url,{method:'POST',headers:{authorization:`Bearer ${gateway.bearerToken}`,'content-type':'application/json',...(mcpSession?{'mcp-session-id':mcpSession}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})})
        assert.equal(response.status,200);mcpSession=response.headers.get('mcp-session-id')??mcpSession;const value=await response.json();assert.ok(!value.error,JSON.stringify(value.error));return value.result
      }
      await rpc('initialize',{protocolVersion:'2025-06-18'})
      const list=await rpc('tools/list');for(const name of ['search_gmail','read_gmail','gmail_draft','read_x_post','x_post_draft','slack_message_draft','github_comment_draft'])assert.ok(list.tools.some(t=>t.name===name),name)
      const search=await rpc('tools/call',{name:'search_gmail',arguments:{query:'fixture',account_id:idB}});assert.ok(!search.isError);assert.match(JSON.stringify(search),/fixture_message/)
      const read=await rpc('tools/call',{name:'read_gmail',arguments:{message_id:'fixture_message',account_id:idB}});assert.ok(!read.isError);assert.match(JSON.stringify(read),/Mailbox B/);assert.match(JSON.stringify(read),/html-text/);assert.ok(!JSON.stringify(read).includes('fixture-refresh'))
      const before=calls;const denied=await rpc('tools/call',{name:'shell',arguments:{command:'echo must-not-run'}});assert.equal(denied.isError,true);assert.equal(calls,before)
    }
    const restricted={...bot,id:'fixture-restricted',tools:[...app.DEFAULT_BOT_TOOLS]};fixture.bots.set(restricted.id,restricted)
    app.setExecutionAgent('restricted',restricted.executionAgent,restricted.id)
    assert.ok(!app.schemasFor(app.bindExecutionAgent('restricted',restricted).tools).some(s=>s.name==='read_gmail'))
    assert.ok(!app.schemasFor(bound.tools,{kind:'vm',vmId:'fixture'}).some(s=>s.name==='read_gmail'))
    assert.equal(posts,0);assert.equal(fixture.approvals,0)
  }finally{
    for(const id of attached)await app.detachSession(id)
    app.clearExecutionAgent('worker');app.clearExecutionAgent('restricted');app.invalidateGoogleAccessToken('gmail');app.setGoogleOAuthTransportForTests();app.setGoogleStorageForTests(undefined)
    await rm(root,{recursive:true,force:true})
  }
})
