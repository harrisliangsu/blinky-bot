import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeBackend } from './claude.ts'
import { grokBackend } from './grok.ts'
import { kimiBackend } from './kimi.ts'
import { getProviderBinding, loadProviderBindings, resetProviderBindingsForTests } from '../../store/providerBindings.ts'
import { flushAll } from '../../store/jsonStore.ts'

test('the chat consumer can stop at done after each CLI has persisted its resume binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-cli-consumer-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const bindingFile = join(root, 'bindings.json')
  const binary = join(root, 'fake-cli')
  await writeFile(binary, `#!/usr/bin/env node
const a=process.argv.slice(2), out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(a.includes('--fixture-kimi')) require('node:fs').appendFileSync('kimi-captured.jsonl',JSON.stringify(a)+'\\n');
process.stdin.resume(); process.stdin.on('end',()=>{
 const resumed=a.includes('--resume')||a.includes('--session');
 if(a.includes('--fixture-kimi')) {out({role:'meta',session_id:'kimi-session'});out({role:'assistant',content:resumed?'resumed':'started'});}
 if(a.includes('--fixture-grok')) {out({type:'text',data:resumed?'resumed':'started'});out({type:'end',sessionId:'grok-session'});}
 if(a.includes('--fixture-claude')) out({type:'assistant',message:{content:resumed?'resumed':'started'}});
});
`)
  await chmod(binary, 0o700)
  try {
    resetProviderBindingsForTests(bindingFile)
    await loadProviderBindings()
    for (const backend of [kimiBackend, grokBackend, claudeBackend]) {
      const sessionKey = `conversation-${backend.id}`
      const request = { model: 'default', messages: [{ role: 'system' as const, content: 'original shared preference' }, { role: 'user' as const, content: 'hello' }], sessionKey, cwd: root, signal: new AbortController().signal }
      const config = { enabled: true, command: binary, extraArgs: [`--fixture-${backend.id}`] }
      let result = ''
      // This is how streamAssistantTurn consumes a backend: it stops on done.
      for await (const chunk of backend.chat(request, config)) {
        if (chunk.type === 'done') break
        if (chunk.type === 'text') result += chunk.delta ?? ''
      }
      assert.equal(result, 'started')
      const expected = getProviderBinding(backend.id, sessionKey)?.nativeThreadId
      assert.ok(expected, `${backend.id} did not record its thread before done`)
      resetProviderBindingsForTests(bindingFile)
      await loadProviderBindings()
      assert.equal(getProviderBinding(backend.id, sessionKey)?.nativeThreadId, expected, `${backend.id} did not persist its thread before done`)
      result = ''
      request.messages = [{ role: 'system' as const, content: 'new shared preference from another bot' }, { role: 'user' as const, content: 'hello' }, { role: 'user' as const, content: 'continue' }]
      for await (const chunk of backend.chat(request, config)) {
        if (chunk.type === 'done') break
        if (chunk.type === 'text') result += chunk.delta ?? ''
      }
      assert.equal(result, 'resumed', `${backend.id} did not pass its saved thread to the CLI`)
      if (backend.id === 'kimi') {
        const captured = (await readFile(join(root, 'kimi-captured.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
        assert.equal(captured.length, 2)
        assert.ok(captured[1].includes('--session'))
        assert.match(captured[1][captured[1].indexOf('-p') + 1], /new shared preference from another bot/)
      }
    }
  } finally {
    await flushAll()
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
