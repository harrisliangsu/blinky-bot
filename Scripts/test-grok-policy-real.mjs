/** Real local Grok, no model prompt or file operation. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrokPolicyProbe } from '../src/main/backends/cli/grokPolicyProbe.ts'

const cwd=await mkdtemp(join(tmpdir(),'blinky-grok-policy-test-'))
async function start(){
 const probe=await createGrokPolicyProbe(),p=spawn('grok',['--no-auto-update','--permission-mode','default','agent','--plugin-dir',probe.pluginDir,'stdio'],{cwd,env:{...process.env,BLINKY_GROK_POLICY_MARKER:probe.markerPath},stdio:['pipe','pipe','ignore']});let n=0;const pending=new Map()
 createInterface({input:p.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}catch{}})
 function rpc(method,params){const id=++n;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,m=>{clearTimeout(timer);if(m.error)reject(Error(m.error.message));else resolve(m.result||{})});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
 try{await rpc('initialize',{protocolVersion:1,clientCapabilities:{}});await rpc('authenticate',{methodId:'cached_token',_meta:{headless:true}});return{p,probe,rpc}}catch(e){p.kill();await probe.cleanup();throw e}
}
let a,b
try{
 a=await start();const created=await a.rpc('session/new',{cwd,mcpServers:[]});assert.ok(created.sessionId);await a.probe.verify(created.sessionId);a.p.kill();await a.probe.cleanup();a=undefined
 b=await start();await b.rpc('session/load',{sessionId:created.sessionId,cwd,mcpServers:[]});await b.probe.verify(created.sessionId)
 console.log(JSON.stringify({realGrok:true,newSessionModeConfirmed:true,resumedSessionModeConfirmed:true,noPrompt:true}))
}finally{a?.p.kill();b?.p.kill();await a?.probe.cleanup();await b?.probe.cleanup();await rm(cwd,{recursive:true,force:true})}
