import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kimiBackend } from './kimi.ts'
import { loadProviderBindings, resetProviderBindingsForTests } from '../../store/providerBindings.ts'
import { flushAll } from '../../store/jsonStore.ts'
import type { ChatRequest } from '../types.ts'

const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline'); const path = require('node:path');
const trace = path.join(__dirname, 'trace.jsonl'); const enabled = name => fs.existsSync(path.join(__dirname, name));
const record = x => fs.appendFileSync(trace, JSON.stringify(x)+'\n');
record({args:process.argv.slice(2)}); const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
let waiting=false,promptId;
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line); record(m);
 if(m.id===900){waiting=false;send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text: m.result?.outcome?.optionId==='no'?'permission denied':'permission allowed'}}}});send({id:promptId,result:{stopReason:'end_turn'}});return;}
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true},promptCapabilities:{image:true}}}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'kimi-acp-test'}});
 else if(m.method==='session/load') { if(enabled('fail-load'))send({id:m.id,error:{code:-32002,message:'load failed'}});else send({id:m.id,result:{}}); }
 else if(m.method==='session/set_config_option')send({id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:enabled('bad-config')?'wrong':m.params.value}]}});
 else if(m.method==='session/prompt') { promptId=m.id; if(enabled('hang'))return;
   if(enabled('permission-diff')){send({method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:'edit-1',kind:'edit',title:'Edit',content:[{type:'content',content:{type:'text',text:JSON.stringify({path:'/tmp/fixture'})}}]}}});send({id:900,method:'session/request_permission',params:{toolCall:{toolCallId:'edit-1',title:'Edit',content:[{type:'diff',path:'/tmp/fixture',oldText:'before',newText:'after'}]},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});return;}
   if(enabled('permission')){waiting=true;send({id:900,method:'session/request_permission',params:{toolCall:{...(enabled('no-kind')?{}:{kind:'edit'}),title:'test edit',rawInput:{path:'/tmp/fixture'}},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}}); return;}
   if(enabled('tool-trace')){send({method:'session/update',params:{update:{sessionUpdate:'tool_call',toolCallId:'tool-1',kind:'execute',title:'Read fixture',rawInput:{password:'fixture-secret'}}}});send({method:'session/update',params:{update:{sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{token:'fixture-secret',result:'done'}}}})}
   send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP response'}}}});send({id:m.id,result:{stopReason:'end_turn'}});
 }
});
`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'blinky-kimi-acp-'))
  const binary = join(root, 'fake-kimi')
  const trace = join(root, 'trace.jsonl')
  await writeFile(binary, FAKE); await chmod(binary, 0o700)
  return { root, binary, trace, bindingFile: join(root, 'bindings.json') }
}
const readTrace = async (file: string): Promise<Array<Record<string, any>>> => (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
async function waitForPrompt(trace: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      if ((await readTrace(trace)).some((entry) => entry.method === 'session/prompt')) return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the ACP prompt')
}
const config = (binary: string) => ({ enabled: true, command: binary, extraArgs: [] })
const gateway = { name: 'openbot', transport: 'http' as const, url: 'http://127.0.0.1:12345/mcp', bearerToken: 'fixture-secret' }
async function collect(request: ChatRequest, binary: string): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of kimiBackend.chat(request, config(binary))) chunks.push(chunk.type === 'text' ? chunk.delta : chunk.type)
  return chunks
}

test('ACP forwards per-turn MCP and image, persists a session and resumes without exposing headers in argv', async () => {
  const f = await fixture()
  try {
    resetProviderBindingsForTests(f.bindingFile); await loadProviderBindings()
    const req: ChatRequest = { model: 'demo/model', thinking: 'high', supportsVision: true, cwd: f.root, sessionKey: 'acp-conversation', signal: new AbortController().signal, mcpServers: [gateway], messages: [{ role: 'system', content: 'original preference' }, { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', mime: 'image/png', data: 'aGk=' }] }] }
    assert.deepEqual(await collect(req, f.binary), ['ACP response', 'done'])
    resetProviderBindingsForTests(f.bindingFile); await loadProviderBindings()
    req.messages = [{ role: 'system', content: 'updated preference' }, { role: 'user', content: 'hello' }, { role: 'user', content: 'follow up' }]
    assert.deepEqual(await collect(req, f.binary), ['ACP response', 'done'])
    const trace = await readTrace(f.trace); const calls = trace.filter((e) => e.method)
    assert.equal(calls.filter((e) => e.method === 'session/new').length, 1)
    assert.equal(calls.filter((e) => e.method === 'session/load').length, 1)
    for (const [configId, value] of [['mode', 'default'], ['model', 'demo/model'], ['thinking', 'high']]) assert.equal(calls.filter((e) => e.method === 'session/set_config_option' && e.params.configId === configId && e.params.value === value).length, 2)
    const newCall = calls.find((e) => e.method === 'session/new')!
    assert.equal(newCall.params.mcpServers[0].headers[0].value, 'Bearer fixture-secret')
    const prompts = calls.filter((e) => e.method === 'session/prompt')
    assert.equal(prompts[0].params.prompt[1].data, 'aGk=')
    assert.match(prompts[1].params.prompt[0].text, /updated preference/)
    for (const spawn of trace.filter((e) => e.args)) assert.ok(!JSON.stringify(spawn.args).includes('fixture-secret'))
    await writeFile(join(f.root, 'bad-config'), '')
    await assert.rejects(collect(req, f.binary), /did not confirm/)
  } finally {
    await flushAll()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('ACP load failure is surfaced without silently starting a new thread', async () => {
  const f = await fixture()
  try {
    resetProviderBindingsForTests(f.bindingFile); await loadProviderBindings()
    const req: ChatRequest = { model: 'default', cwd: f.root, sessionKey: 'load-failure', signal: new AbortController().signal, mcpServers: [gateway], messages: [{role:'user',content:'first'}] }
    await collect(req, f.binary)
    await writeFile(join(f.root, 'fail-load'), '')
    await assert.rejects(collect(req, f.binary), /load failed/)
    const trace = await readTrace(f.trace)
    assert.equal(trace.filter((e) => e.method === 'session/new').length, 1)
    assert.equal(trace.filter((e) => e.method === 'session/load').length, 1)
  } finally {
    await flushAll()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('ACP forwards explicit permission requests to the application and respects rejection', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'permission'), '')
    let approvals=0
    const req: ChatRequest = { model: 'default', cwd: f.root, signal: new AbortController().signal, mcpServers: [gateway], messages: [{role:'user',content:'test'}], approve: async (request) => { approvals++; assert.equal(request.force, true); assert.equal(request.target, '/tmp/fixture'); assert.match(request.detail, /test edit/); return 'reject' } }
    await assert.rejects(collect(req, f.binary), /未获批准.*\/tmp\/fixture.*本轮已停止/); assert.equal(approvals, 1)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('ACP surfaces permission requests with no kind as forced generic approvals', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'permission'), '')
    await writeFile(join(f.root, 'no-kind'), '')
    let approvals=0
    const req: ChatRequest = { model:'default',cwd:f.root,signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}],approve:async (request) => { approvals++;assert.equal(request.kind,'mcp');assert.equal(request.force,true);assert.equal(request.target,'/tmp/fixture');return 'reject' } }
    await assert.rejects(collect(req, f.binary), /未获批准.*\/tmp\/fixture/)
    assert.equal(approvals,1)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('ACP uses the prior tool event and diff to show the real approval target', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'permission-diff'), '')
    let approvals=0
    const req: ChatRequest = { model:'default',cwd:f.root,signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}],approve:async (request) => { approvals++;assert.equal(request.kind,'edit');assert.equal(request.force,true);assert.equal(request.target,'/tmp/fixture');assert.match(request.detail,/before/);assert.match(request.detail,/after/);return 'reject' } }
    await assert.rejects(collect(req, f.binary), /未获批准.*\/tmp\/fixture/)
    assert.equal(approvals,1)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('ACP continues when the user approves a native request once', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'permission'), '')
    const req: ChatRequest = { model:'default',cwd:f.root,signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}],approve:async () => 'approve' }
    assert.deepEqual(await collect(req, f.binary), ['permission allowed','done'])
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('a governed Kimi turn uses ACP even when the application gateway is missing', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'permission'), '')
    const req: ChatRequest = { model:'default',cwd:f.root,signal:new AbortController().signal,messages:[{role:'user',content:'test'}],approve:async () => 'reject' }
    await assert.rejects(collect(req, f.binary), /未获批准/)
    const trace=await readTrace(f.trace)
    assert.ok(trace.some((entry) => entry.method==='session/new'))
    assert.ok(!trace.some((entry) => Array.isArray(entry.args) && entry.args.includes('-p')))
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('ACP cancellation stops a pending turn without emitting done', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'hang'), '')
    const controller = new AbortController(); const req: ChatRequest = { model:'default',cwd:f.root,signal:controller.signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}] }
    const pending = collect(req, f.binary)
    void pending.catch(() => {})
    try {
      await waitForPrompt(f.trace)
      controller.abort()
      assert.deepEqual(await pending, [])
    } finally {
      controller.abort()
      await pending.catch(() => {})
    }
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('ACP exposes redacted tool events to execution transcripts only', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'tool-trace'), '')
    const req: ChatRequest = { model:'default',cwd:f.root,signal:new AbortController().signal,mcpServers:[gateway],messages:[{role:'user',content:'test'}],captureAgentTrace:true }
    const chunks = []
    for await (const chunk of kimiBackend.chat(req, config(f.binary))) chunks.push(chunk)
    const traces = chunks.filter((chunk) => chunk.type === 'agent_trace')
    assert.deepEqual(traces.map((chunk) => chunk.type === 'agent_trace' && chunk.entry.phase), ['started', 'completed'])
    assert.ok(!JSON.stringify(traces).includes('fixture-secret'))
    req.captureAgentTrace = false
    const hidden = []
    for await (const chunk of kimiBackend.chat(req, config(f.binary))) hidden.push(chunk)
    assert.ok(!hidden.some((chunk) => chunk.type === 'agent_trace'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
