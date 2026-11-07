import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAgentCli } from './detect.ts'
import { CLAUDE_SPEC, claudeBackend } from './claude.ts'
import { piBackend } from './pi.ts'
import { probeVersion } from '../versionProbe.ts'
import { noteTiming } from '../chatTiming.ts'
import { runCodexAppServer } from './codexAppServer.ts'
import { listCodexModels } from './codexModels.ts'
import type { ChatChunk, ChatRequest } from '../types.ts'

async function fixture(program: string) {
  const root = await mkdtemp(join(tmpdir(), 'blinky-cli-startup-'))
  const binary = join(root, 'fixture.cjs')
  await writeFile(binary, `#!${process.execPath}\n${program}`)
  await chmod(binary, 0o700)
  return { root, binary }
}

test('a version-check signal is retained and never reported as signed out', async () => {
  const f = await fixture(`
if(process.argv.includes('--version'))process.kill(process.pid,'SIGKILL');
else process.stdout.write(JSON.stringify({loggedIn:true}));
`)
  try {
    const probe = await probeVersion(f.binary)
    assert.equal(probe.outcome, 'nonzero')
    assert.equal(probe.signal, 'SIGKILL')
    const info = await detectAgentCli(CLAUDE_SPEC, { enabled: true, command: f.binary })
    assert.equal(info.status, 'error')
    assert.equal(info.cliAuth?.state, 'logged-in')
    assert.match(info.detail ?? '', /terminated by SIGKILL/)
    assert.doesNotMatch(info.detail ?? '', /run .*login|sign in\./i)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('Claude adapter delivers partial public text before exit, hides private events and deduplicates the snapshot', async () => {
  const f = await fixture(`
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(__dirname,'args.json'),JSON.stringify(process.argv.slice(2)));
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.stdin.resume();process.stdin.on('end',()=>{
 const event=event=>emit({type:'stream_event',event});
 event({type:'message_start',message:{id:'public-message'}});
 event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'PRIVATE'}});
 event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE'}});
 event({type:'content_block_start',index:1,content_block:{type:'text',text:''}});
 event({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'PUBLIC'}});
 setTimeout(()=>{emit({type:'assistant',message:{id:'public-message',content:[{type:'thinking',thinking:'PRIVATE'},{type:'text',text:'PUBLIC'}]}});process.exit(0)},200);
});
`)
  try {
    const request: ChatRequest = { model: 'default', cwd: f.root, messages: [{ role: 'user', content: 'text only' }], readOnly: true, signal: new AbortController().signal }
    const chunks: ChatChunk[] = []
    for await (const chunk of claudeBackend.chat(request, { enabled: true, command: f.binary })) {
      chunks.push(chunk)
      if (chunk.type === 'text' && chunk.visible) assert.ok(!chunks.some(c => c.type === 'done'))
    }
    assert.equal(chunks.flatMap(c => c.type === 'text' && c.visible ? [c.delta] : []).join(''), 'PUBLIC')
    assert.ok(chunks.some(c => c.type === 'reasoning'))
    const args = JSON.parse(await readFile(join(f.root, 'args.json'), 'utf8')) as string[]
    assert.ok(args.includes('--include-partial-messages'))
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.ok(!args.includes('--model'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('pi OAuth rejection is a failed turn with no invented public reply or model override', async () => {
  const f = await fixture(`
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(__dirname,'args.json'),JSON.stringify(process.argv.slice(2)));
process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('OAuth refresh failed: 400 invalid_grant');process.exitCode=1});
`)
  try {
    const request: ChatRequest = { model: 'default', cwd: f.root, messages: [{ role: 'user', content: 'text only' }], readOnly: true, signal: new AbortController().signal }
    const chunks: ChatChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of piBackend.chat(request, { enabled: true, command: f.binary })) chunks.push(chunk)
    }, /OAuth refresh failed: 400 invalid_grant/)
    assert.equal(chunks.filter(c => c.type === 'text' && c.visible).length, 0)
    assert.equal(chunks.filter(c => c.type === 'done').length, 0)
    const args = JSON.parse(await readFile(join(f.root, 'args.json'), 'utf8')) as string[]
    assert.ok(args.includes('--no-tools'))
    assert.ok(!args.includes('--model'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('diagnostic observers cannot fail the turn', () => {
  assert.doesNotThrow(() => noteTiming(() => { throw new Error('observer failure') }, 'model-request'))
})

test('Codex chat and catalog acknowledge initialization before opening a thread or discovering models', async () => {
  const f = await fixture(`
const readline=require('node:readline');let initialized=false;
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){emit({id:m.id,result:{}});return}
 if(m.method==='initialized'){initialized=true;return}
 if(!initialized){emit({id:m.id,error:{code:-1,message:'initialization acknowledgement missing'}});return}
 if(m.method==='model/list')emit({id:m.id,result:{data:[{id:'fixture-model'}]}});
 if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'fixture-thread'}}});
 if(m.method==='turn/start'){
  emit({id:m.id,result:{}});
  emit({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'fixture-turn'}}});
  emit({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',turnId:'fixture-turn',itemId:'answer',delta:'PUBLIC'}});
  emit({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[]}}});
 }
});
`)
  try {
    assert.equal((await listCodexModels(f.binary, f.root))[0]?.id, 'fixture-model')
    const stages: string[] = [], chunks: ChatChunk[] = []
    const req: ChatRequest = { model: 'default', messages: [{ role: 'user', content: 'text' }], readOnly: true, signal: new AbortController().signal, onTiming: stage => { stages.push(stage) } }
    for await (const chunk of runCodexAppServer({ binaryPath: f.binary, ctx: { model: 'default', cwd: f.root, extraArgs: [] }, req })) chunks.push(chunk)
    assert.equal(chunks.flatMap(c => c.type === 'text' && c.visible ? [c.delta] : []).join(''), 'PUBLIC')
    assert.ok(stages.indexOf('runtime-ready') < stages.indexOf('thread-ready'))
    assert.ok(stages.indexOf('thread-ready') < stages.indexOf('model-request'))
    assert.ok(stages.indexOf('model-request') < stages.indexOf('model-request-accepted'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
