/** Isolated real ACP probe: deny any permission request and touch only a temporary fixture. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrokPolicyProbe } from '../src/main/backends/cli/grokPolicyProbe.ts'

const provider=process.env.BLINKY_TEST_CLI==='kimi'?'kimi':'grok'
const cwd=await mkdtemp(join(tmpdir(),`blinky-${provider}-native-test-`))
const fixture=join(cwd,'fixture.txt')
await writeFile(fixture,'before')
const probe=provider==='grok'?await createGrokPolicyProbe():null
const child=spawn(provider,provider==='grok'?['--no-auto-update','--permission-mode','default','agent','--plugin-dir',probe.pluginDir,'stdio']:['acp'],{cwd,env:{...process.env,...(probe?{BLINKY_GROK_POLICY_MARKER:probe.markerPath}:{})},stdio:['pipe','pipe','ignore']})
let sequence=0, permissionRequests=0, text='', toolStarts=0, toolEnds=0
const unsupportedMethods=[]
const pending=new Map()
createInterface({input:child.stdout}).on('line',line=>{try{
 const msg=JSON.parse(line)
 if(msg.method==='session/request_permission'){
  permissionRequests++
  const options=msg.params?.options||[], reject=options.find(x=>x.kind==='reject_once')||options.find(x=>x.kind==='reject_always')
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{outcome:reject?{outcome:'selected',optionId:reject.optionId}:{outcome:'cancelled'}}})+'\n')
 }else if(msg.method==='session/update'){
  const update=msg.params?.update||{}
  if(update.sessionUpdate==='tool_call')toolStarts++
  if(update.sessionUpdate==='tool_call_update'&&['completed','failed'].includes(update.status))toolEnds++
  if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')text+=update.content.text
 }else if(msg.method&&msg.id!==undefined){unsupportedMethods.push(msg.method);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Unsupported client method'}})+'\n')}
 else if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id)}
}catch{}})
function rpc(method,params,timeout=20000){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},timeout);pending.set(id,msg=>{clearTimeout(timer);msg.error?reject(Error(msg.error.message)):resolve(msg.result||{})});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
try{
 const init=await rpc('initialize',{protocolVersion:1,clientCapabilities:{}})
 if(provider==='grok'){const methods=(init.authMethods||[]).map(x=>x.id);await rpc('authenticate',{methodId:process.env.XAI_API_KEY&&methods.includes('xai.api_key')?'xai.api_key':'cached_token',_meta:{headless:true}})}
 const session=await rpc('session/new',{cwd,mcpServers:[]});assert.ok(session.sessionId)
 if(probe)await probe.verify(session.sessionId)
 else{const result=await rpc('session/set_config_option',{sessionId:session.sessionId,configId:'mode',value:'default'});assert.ok(result.configOptions?.some(x=>x.id==='mode'&&x.currentValue==='default'))}
 const effort=provider==='grok'?'reasoning_effort':'thinking'
 const configured=await rpc('session/set_config_option',{sessionId:session.sessionId,configId:effort,value:'low'})
 assert.ok(configured.configOptions?.some(x=>x.id===effort&&x.currentValue==='low'))
 await rpc('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'In the current directory use a file tool to change fixture.txt from before to after, then briefly report the result.'}]},60000)
 const contents=await readFile(fixture,'utf8')
 if(permissionRequests&&contents!=='before')throw Error('Fixture changed after denying a native permission request')
 console.log(JSON.stringify({realProvider:provider,permissionRequests,toolStarts,toolEnds,unsupportedMethods,fixtureChanged:contents!=='before',replyReceived:Boolean(text.trim())}))
}catch(error){
 const contents=await readFile(fixture,'utf8').catch(()=>null)
 console.error(JSON.stringify({realProvider:provider,error:String(error),permissionRequests,toolStarts,toolEnds,unsupportedMethods,fixtureChanged:contents!==null&&contents!=='before',replyReceived:Boolean(text.trim())}))
 throw error
}finally{child.kill();await probe?.cleanup();await rm(cwd,{recursive:true,force:true})}
