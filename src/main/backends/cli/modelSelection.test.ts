import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeBackend } from './claude.ts'
import { droidBackend } from './droid.ts'
import { piBackend } from './pi.ts'
import { opencodeBackend } from './opencode.ts'
import { thinkingOptions } from '../../../shared/thinking.ts'
import { conversationKey } from '../../agent/conversationKey.ts'
import type { Bot, Session } from '../../../shared/types.ts'

test('the application isolates native bindings by Bot, directory, model and depth', () => {
  const bot = { id: 'bot-a', backendId: 'codex', modelId: 'chosen-model', thinking: 'high' } as Bot
  const session = { id: 'continuous-chat', cwd: '/workspace' } as Session
  const key = conversationKey(session, bot)
  for (const change of [{ id: 'bot-b' }, { backendId: 'kimi' }, { modelId: 'default' }, { thinking: undefined }]) {
    assert.notEqual(conversationKey(session, { ...bot, ...change } as Bot), key)
  }
  assert.notEqual(conversationKey({ ...session, cwd: '/other' }, bot), key)
  assert.equal(conversationKey(session, { ...bot }), key)
})

// These transports do not advertise a thinking picker. Exercise the complete
// adapter boundary so a saved model must reach argv or the HTTP session body.
test('Claude, Droid, pi and OpenCode send the selected model and delegate default to the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-model-routing-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const binary = join(root, 'fake-cli')
  const trace = join(root, 'trace.jsonl')
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http');
const args=process.argv.slice(2),record=x=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+'\\n');
if(args[0]==='serve') {
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',d=>body+=d);req.on('end',()=>{
   record({path:req.url,body:body?JSON.parse(body):null});
   if(req.url==='/api/session'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:'model-session'}}));}
   else if(req.url==='/api/event'){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({type:'session.idle',data:{sessionID:'model-session'}})+'\\n\\n');}
   else res.end('{}');
  });
 });
 server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
} else {
 record({args});process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'assistant',message:{content:'model fixture'}})));
}
`)
  await chmod(binary, 0o700)
  try {
    for (const backend of [claudeBackend, droidBackend, piBackend, opencodeBackend]) {
      for (const model of ['fixture/chosen-model', 'default']) {
        await writeFile(trace, '')
        const chunks = []
        for await (const chunk of backend.chat({
          model, cwd: root, messages: [{ role: 'user', content: 'model routing probe' }],
          signal: AbortSignal.timeout(15_000)
        }, { enabled: true, command: binary })) chunks.push(chunk)
        assert.ok(chunks.some((chunk) => chunk.type === 'done'), backend.id)
        const records = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        if (backend.id === 'opencode') {
          const request = records.find((item) => item.path === '/api/session')
          assert.deepEqual(request.body, model === 'default' ? {} : { model: { providerID: 'fixture', id: 'chosen-model' } })
          assert.match(records.find((item) => item.path.endsWith('/prompt')).body.prompt.text, /model routing probe/)
        } else {
          const args = records.find((item) => item.args).args as string[]
          if (model === 'default') assert.equal(args.includes('--model'), false, backend.id)
          else assert.equal(args[args.indexOf('--model') + 1], model, backend.id)
        }
      }
      assert.deepEqual(thinkingOptions(backend.id, 'fixture/chosen-model', []), [], backend.id)
    }
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
