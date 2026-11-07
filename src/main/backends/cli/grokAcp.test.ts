import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grokBackend } from './grok.ts'
import { loadProviderBindings, resetProviderBindingsForTests } from '../../store/providerBindings.ts'
import { flushAll } from '../../store/jsonStore.ts'
import type { ChatRequest } from '../types.ts'

const FAKE = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline'),path=require('node:path');const trace=path.join(__dirname,'trace.jsonl'),send=x=>process.stdout.write(JSON.stringify(x)+'\n'),record=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\n');let promptId;const mark=()=>{if(!fs.existsSync(path.join(__dirname,'missing-mode')))fs.writeFileSync(process.env.BLINKY_GROK_POLICY_MARKER,JSON.stringify({event:'session_start',mode:fs.existsSync(path.join(__dirname,'unsafe-mode'))?'bypassPermissions':'default',sessionId:'grok-acp-test'}))};record({args:process.argv.slice(2)});readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);record(m);if(m.id===900){send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result?.outcome?.optionId==='no'?'rejected':'allowed'}}}});send({id:promptId,result:{stopReason:'end_turn'}})}else if(m.method==='initialize')send({id:m.id,result:{authMethods:[{id:'cached_token'},{id:'xai.api_key'}],agentCapabilities:{mcpCapabilities:{http:true},promptCapabilities:{image:true}}}});else if(m.method==='authenticate')send({id:m.id,result:{}});else if(m.method==='session/new'){mark();send({id:m.id,result:{sessionId:'grok-acp-test'}})}else if(m.method==='session/load'){if(fs.existsSync(path.join(__dirname,'fail-load')))send({id:m.id,error:{code:-32002,message:'load failed'}});else{mark();send({id:m.id,result:{}})}}else if(m.method==='session/set_config_option')send({id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:fs.existsSync(path.join(__dirname,'bad-config'))?'wrong':m.params.value}]}});else if(m.method==='session/prompt'){promptId=m.id;if(fs.existsSync(path.join(__dirname,'permission')))send({id:900,method:'session/request_permission',params:{toolCall:{kind:'edit',title:'Fixture edit'},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});else{send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP response'}}}});send({id:m.id,result:{stopReason:'end_turn'}})}}});
`
async function fixture() { const root=await mkdtemp(join(tmpdir(),'blinky-grok-acp-')), binary=join(root,'fake-grok'); await writeFile(binary,FAKE);await chmod(binary,0o700);return {root,binary,trace:join(root,'trace.jsonl'),binding:join(root,'bindings.json')} }
const readTrace = async (file: string): Promise<Array<Record<string, any>>> => (await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
async function collect(req: ChatRequest, binary: string, extraArgs: string[] = []): Promise<string[]> { const out: string[]=[];for await(const chunk of grokBackend.chat(req,{enabled:true,command:binary,extraArgs}))out.push(chunk.type==='text'?chunk.delta:chunk.type);return out }
const gateway = {name:'openbot',transport:'http' as const,url:'http://127.0.0.1:12345/mcp',bearerToken:'fixture-secret'}

test('Grok ACP authenticates, receives MCP and resumes the same session without exposing credentials in argv', async () => {
  const f=await fixture()
  try {
    resetProviderBindingsForTests(f.binding);await loadProviderBindings()
    const req:ChatRequest={model:'grok-test',thinking:'low',supportsVision:true,cwd:f.root,sessionKey:'grok-acp-conversation',signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'system',content:'original rule'},{role:'user',content:[{type:'text',text:'hello'},{type:'image',mime:'image/png',data:'aGk='}]}]}
    assert.deepEqual(await collect(req,f.binary),['ACP response','done'])
    resetProviderBindingsForTests(f.binding);await loadProviderBindings()
    req.messages=[{role:'system',content:'updated rule'},{role:'user',content:'hello'},{role:'user',content:'follow up'}]
    assert.deepEqual(await collect(req,f.binary),['ACP response','done'])
    const trace=await readTrace(f.trace),calls=trace.filter(e=>e.method)
    assert.equal(calls.filter(e=>e.method==='authenticate'&&e.params.methodId==='cached_token').length,2)
    assert.equal(calls.filter(e=>e.method==='session/new').length,1);assert.equal(calls.filter(e=>e.method==='session/load').length,1)
    assert.equal(calls.filter(e=>e.method==='session/set_config_option'&&e.params.configId==='model'&&e.params.value==='grok-test').length,2)
    assert.equal(calls.filter(e=>e.method==='session/set_config_option'&&e.params.configId==='reasoning_effort'&&e.params.value==='low').length,2)
    assert.equal(calls.find(e=>e.method==='session/new')!.params.mcpServers[0].headers[0].value,'Bearer fixture-secret')
    assert.equal(calls.filter(e=>e.method==='session/prompt')[0]!.params.prompt[1].data,'aGk=')
    assert.match(calls.filter(e=>e.method==='session/prompt')[1]!.params.prompt[0].text,/updated rule/)
    for(const spawn of trace.filter(e=>e.args)){assert.ok(!JSON.stringify(spawn.args).includes('fixture-secret'));assert.ok(spawn.args.includes('--permission-mode'));assert.ok(!spawn.args.includes('--always-approve'))}
    await writeFile(join(f.root,'bad-config'),'');await assert.rejects(collect(req,f.binary),/did not confirm/);await rm(join(f.root,'bad-config'))
    const prompted=(await readTrace(f.trace)).filter(e=>e.method==='session/prompt').length
    await writeFile(join(f.root,'unsafe-mode'),'');await assert.rejects(collect(req,f.binary),/did not confirm its normal permission mode/);await rm(join(f.root,'unsafe-mode'))
    await writeFile(join(f.root,'missing-mode'),'');await assert.rejects(collect(req,f.binary),/did not report its permission mode/);await rm(join(f.root,'missing-mode'))
    assert.equal((await readTrace(f.trace)).filter(e=>e.method==='session/prompt').length,prompted)
    await writeFile(join(f.root,'fail-load'),'');await assert.rejects(collect(req,f.binary),/load failed/)
    assert.equal((await readTrace(f.trace)).filter(e=>e.method==='session/new').length,1)
  } finally {await flushAll();await rm(f.root,{recursive:true,force:true})}
})

test('Grok ACP forwards an explicit permission to the application and cannot be made always-approve through extra args', async () => {
  const f=await fixture()
  try {
    await writeFile(join(f.root,'permission'),'');let called=0
    const req:ChatRequest={model:'default',cwd:f.root,signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}],approve:async request=>{called++;assert.equal(request.force,true);return 'reject'}}
    await assert.rejects(collect(req,f.binary),/未获批准.*Fixture edit.*本轮已停止/);assert.equal(called,1)
    await assert.rejects(collect(req,f.binary,['--always-approve']),/cannot override/)
  } finally {await rm(f.root,{recursive:true,force:true})}
})
