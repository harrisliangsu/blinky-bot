import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { runCodexAppServer, steerCodexTurn, stopWarmCodex } from './codexAppServer.ts'
import type { ChatRequest } from '../types.ts'
import { deliveredFingerprints } from '../../store/providerBindings.ts'
import { flushAll } from '../../store/jsonStore.ts'
import { fingerprints } from './resumePrompt.ts'
import { toProviderMessages } from '../../agent/history.ts'

test('Codex steering reaches the active turn and is recorded before completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blinky-steer-'))
  const prior = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = dir
  const script = join(dir, 'fake-codex')
  const trace = join(dir, 'trace.json')
  await writeFile(script, `#!/usr/bin/env node
const readline = require('node:readline');
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') emit({id:req.id,result:{}});
  if (req.method === 'thread/start') emit({id:req.id,result:{thread:{id:'thread-test'}}});
  if (req.method === 'turn/start') {
    emit({id:req.id,result:{turn:{id:'turn-test'}}});
    emit({method:'turn/started',params:{threadId:'thread-test',turn:{id:'turn-test'}}});
  }
  if (req.method === 'turn/steer') {
    const image = req.params.input.find(item => item.type === 'localImage');
    if (req.params.expectedTurnId !== 'turn-test' || req.params.input[0].text !== 'change direction' || !image || !require('fs').existsSync(image.path)) {
      emit({id:req.id,error:{code:-1,message:'bad steer'}}); return;
    }
    require('fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({path:image.path,mode:require('fs').statSync(image.path).mode & 0o777}));
    emit({id:req.id,result:{turnId:'turn-test'}});
    setTimeout(() => emit({method:'turn/completed',params:{turn:{id:'turn-test',status:'completed',items:[]}}}), 200);
  }
});
`)
  await chmod(script, 0o700)
  const controller = new AbortController()
  try {
    const request = { model: 'default', messages: [{ role: 'user', content: 'start' }], sessionKey: 'session-test', signal: controller.signal } as ChatRequest
    const chunks: string[] = []
    const run = (async () => {
      for await (const chunk of runCodexAppServer({ binaryPath: script, ctx: { cwd: dir, model: 'default', extraArgs: [] }, req: request })) chunks.push(chunk.type)
    })()
    let recorded = false
    let accepted = false
    const image = { type: 'image' as const, mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==' }
    const followup = { role: 'user' as const, content: [{ type: 'text' as const, text: 'change direction' }, image] }
    for (let attempt = 0; attempt < 100 && !accepted; attempt++) {
      accepted = await steerCodexTurn('session-test', 'change direction', async () => { await delay(20); recorded = true }, followup)
      if (!accepted) await delay(20)
    }
    assert.equal(accepted, true)
    const materialized = JSON.parse(await readFile(trace, 'utf8')) as { path: string; mode: number }
    assert.equal(materialized.mode, 0o600)
    await access(materialized.path)
    await run
    await assert.rejects(access(materialized.path))
    assert.equal(recorded, true)
    assert.ok(chunks.includes('done'))
    assert.deepEqual(deliveredFingerprints('session-test'), fingerprints([
      { role: 'user', content: 'start' },
      followup
    ]))
  } finally {
    controller.abort()
    stopWarmCodex()
    await flushAll()
    if (prior === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test('a text-only live model receives an image warning instead of a local image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blinky-steer-text-only-'))
  const prior = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = dir
  const script = join(dir, 'fake-codex')
  const trace = join(dir, 'input.json')
  await writeFile(script, `#!/usr/bin/env node
const readline = require('node:readline');
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line);
  if(req.method==='initialize') emit({id:req.id,result:{}});
  if(req.method==='thread/start') emit({id:req.id,result:{thread:{id:'text-thread'}}});
  if(req.method==='turn/start') {
    emit({id:req.id,result:{turn:{id:'text-turn'}}});
    emit({method:'turn/started',params:{threadId:'text-thread',turn:{id:'text-turn'}}});
  }
  if(req.method==='turn/steer') {
    require('fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify(req.params.input));
    emit({id:req.id,result:{turnId:'text-turn'}});
    emit({method:'turn/completed',params:{turn:{id:'text-turn',status:'completed',items:[]}}});
  }
});
`)
  await chmod(script, 0o700)
  const controller = new AbortController()
  try {
    const request = { model: 'text-model', supportsVision: false, messages: [{ role: 'user', content: 'start' }], sessionKey: 'session-text-only', signal: controller.signal } as ChatRequest
    const run = (async () => { for await (const _ of runCodexAppServer({ binaryPath: script, ctx: { cwd: dir, model: 'text-model', extraArgs: [] }, req: request })) { /* drain */ } })()
    let seen: boolean | undefined
    let recorded = false
    const attachment = { id: 'image-1', kind: 'image' as const, name: 'test.png', mime: 'image/png', data: 'aGVsbG8=' }
    let accepted = false
    for (let attempt = 0; attempt < 100 && !accepted; attempt++) {
      accepted = await steerCodexTurn('session-text-only', 'inspect', async () => { recorded = true }, (supportsVision) => {
        seen = supportsVision
        return toProviderMessages([{ id: 'm1', role: 'user', content: 'inspect', attachments: [attachment], createdAt: Date.now() }], { supportsVision })[0]!
      })
      if (!accepted) await delay(20)
    }
    assert.equal(accepted, true)
    await run
    assert.equal(seen, false)
    assert.equal(recorded, true)
    const input = JSON.parse(await readFile(trace, 'utf8')) as Array<{type: string; text?: string}>
    assert.deepEqual(input.map((item) => item.type), ['text'])
    assert.match(input[0]?.text ?? '', /this model cannot see images/)
  } finally {
    controller.abort()
    stopWarmCodex()
    await flushAll()
    if (prior === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = prior
    await rm(dir, { recursive: true, force: true })
  }
})

test('foreign threads and turns cannot replace or end the active Codex reply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blinky-thread-isolation-'))
  const script = join(dir, 'fake-codex')
  await writeFile(script, `#!/usr/bin/env node
const readline = require('node:readline');
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') emit({id:req.id,result:{}});
  if (req.method === 'thread/start') emit({id:req.id,result:{thread:{id:'parent'}}});
  if (req.method === 'turn/start') {
    emit({id:req.id,result:{turn:{id:'parent-turn'}}});
    emit({method:'turn/started',params:{threadId:'parent',turn:{id:'parent-turn'}}});
    emit({method:'turn/started',params:{threadId:'child',turn:{id:'child-turn'}}});
    emit({method:'item/agentMessage/delta',params:{threadId:'child',turnId:'child-turn',itemId:'child-item',delta:'CHILD'}});
    emit({method:'turn/completed',params:{threadId:'child',turn:{id:'child-turn',status:'completed',items:[]}}});
    emit({method:'item/agentMessage/delta',params:{threadId:'parent',turnId:'other-turn',itemId:'other-item',delta:'OTHER'}});
    setTimeout(() => {
      emit({method:'item/agentMessage/delta',params:{threadId:'parent',turnId:'parent-turn',itemId:'parent-item',delta:'PARENT'}});
      emit({method:'turn/completed',params:{threadId:'parent',turn:{id:'parent-turn',status:'completed',items:[]}}});
    }, 100);
  }
});
`)
  await chmod(script, 0o700)
  const controller = new AbortController()
  try {
    const req = { model: 'default', messages: [{ role: 'user', content: 'hello' }], signal: controller.signal } as ChatRequest
    const chunks = []
    for await (const chunk of runCodexAppServer({ binaryPath: script, ctx: { cwd: dir, model: 'default', extraArgs: [] }, req })) chunks.push(chunk)
    assert.deepEqual(chunks, [{ type: 'text', delta: 'PARENT', visible: true }, { type: 'done' }])
  } finally {
    controller.abort()
    stopWarmCodex()
    await rm(dir, { recursive: true, force: true })
  }
})
