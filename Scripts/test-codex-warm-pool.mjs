/** Isolated fake app-servers verify the idle cap and session reuse. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCodexAppServer, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { resetProviderBindingsForTests, loadProviderBindings } from '../src/main/store/providerBindings.ts'

const root=await mkdtemp(path.join(os.tmpdir(),'blinky-warm-pool-')),bin=path.join(root,'codex'),trace=path.join(root,'trace')
process.env.OPENBOT_DATA_DIR=root
resetProviderBindingsForTests(path.join(root,'bindings.json'));await loadProviderBindings()
await writeFile(bin,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),readline=require('node:readline');fs.appendFileSync(process.env.WARM_POOL_TRACE,'start\n');const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let n=0;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:r.params.threadId||'fixture-thread'},approvalsReviewer:r.params.approvalsReviewer,approvalPolicy:r.params.approvalPolicy,sandbox:{type:'workspaceWrite',networkAccess:false}}});else if(r.method==='turn/start'){const turn='turn-'+(++n);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'fixture-thread'}});send({method:'item/started',params:{item:{type:'agentMessage',id:'m'+n,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m'+n,delta:'ok'}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}})
`);await chmod(bin,0o700);process.env.WARM_POOL_TRACE=trace
async function run(key){const req={cwd:root,model:'fixture',messages:[{role:'user',content:'hello'}],signal:new AbortController().signal,sessionKey:key,approvalPolicy:'auto-run'};const ctx={cwd:root,model:'fixture',extraArgs:[]};const parts=[];for await(const chunk of runCodexAppServer({binaryPath:bin,ctx,req}))parts.push(chunk);assert.ok(parts.some(x=>x.type==='done'))}
async function starts(){return (await readFile(trace,'utf8')).trim().split('\n').length}
try {
 await run('session-one');await run('session-two');await run('session-three');await run('session-four');assert.equal(await starts(),4)
 await run('session-two');assert.equal(await starts(),4,'recent idle server should be reused')
 await run('session-one');assert.equal(await starts(),5,'oldest idle server should be evicted')
 console.log(JSON.stringify({idleCap:3,recentSessionReused:true,oldestIdleEvicted:true}))
} finally { stopWarmCodex();await new Promise(resolve=>setTimeout(resolve,100));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}) }
