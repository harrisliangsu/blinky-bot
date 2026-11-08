import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { confirmClaudeSession, continuityArgs, sessionUuid } from '../backends/cli/claudeSession.ts'
import { rememberCliSession, rememberedCliSession } from '../backends/cli/cliSession.ts'
import { codexTurnPrompt, rememberCodexThread, rememberedCodexThread } from '../backends/cli/codexThread.ts'
import { fingerprints, firstUnsent, rememberSent } from '../backends/cli/resumePrompt.ts'
import { turnImages } from '../backends/cli/cliImages.ts'
import { flushAll } from './jsonStore.ts'
import { discardEphemeralBindingsForSession, forgetBindingsForSession, getProviderBinding, loadProviderBindings, resetProviderBindingsForTests } from './providerBindings.ts'

const dir = mkdtempSync(join(tmpdir(), 'blinky-bindings-'))
const file = join(dir, 'provider-bindings.json')
const sessionId = '11111111-1111-4111-8111-111111111111'
const claudeKey = JSON.stringify(['claude', sessionId, 'bot-a', '/work', 'sonnet'])
const kimiKey = JSON.stringify(['kimi', sessionId, 'bot-a', '/work', 'default'])
const codexKey = JSON.stringify(['codex', sessionId, 'bot-a', '/work', 'default'])
const otherKey = JSON.stringify(['kimi', '22222222-2222-4222-8222-222222222222', 'bot-b', '/work', 'default'])

const messages = [
  { role: 'user' as const, content: 'first' },
  { role: 'assistant' as const, content: 'ack' },
  { role: 'user' as const, content: 'second' }
]

test('discarding one-use judgment bindings leaves ordinary native continuity untouched and no Claude tombstone',async()=>{
 const ephemeral=sessionId+':task-judgment:one'
 const key=JSON.stringify(['claude',ephemeral,'bot-a','/work','sonnet'])
 const normal=JSON.stringify(['kimi',sessionId,'bot-a','/work','judgment-isolation'])
 continuityArgs(key);confirmClaudeSession(key);rememberSent(key,fingerprints(messages))
 rememberCliSession('kimi',normal,'ses_normal')
 discardEphemeralBindingsForSession(ephemeral)
 assert.equal(getProviderBinding('claude',key),undefined)
 assert.equal(firstUnsent(key,fingerprints(messages)),0)
 assert.equal(rememberedCliSession('kimi',normal),'ses_normal')
 await flushAll();resetProviderBindingsForTests(file);await loadProviderBindings()
 assert.equal(getProviderBinding('claude',key),undefined)
 assert.equal(rememberedCliSession('kimi',normal),'ses_normal')
})

before(async () => {
  resetProviderBindingsForTests(file)
  await loadProviderBindings()
})

test('clearing a chat unbinds resume ids and keeps other chats', async () => {
  rememberCliSession('kimi', kimiKey, '--yolo')
  assert.equal(rememberedCliSession('kimi', kimiKey), undefined)

  rememberCliSession('kimi', kimiKey, 'ses_01')
  rememberCliSession('kimi', otherKey, 'ses_keep')
  rememberCodexThread(codexKey, 'thr_01')
  assert.equal(continuityArgs(claudeKey)[0], '--session-id')
  confirmClaudeSession(claudeKey)
  rememberSent(kimiKey, fingerprints(messages.slice(0, 2)))
  rememberSent(codexKey, fingerprints(messages.slice(0, 2)))
  rememberSent(claudeKey, fingerprints(messages))

  const resumed = codexTurnPrompt(messages, codexKey, true)
  assert.equal(resumed, 'second')
  assert.doesNotMatch(resumed, /conversation-so-far/)

  await flushAll()
  resetProviderBindingsForTests(file)
  await loadProviderBindings()

  assert.equal(rememberedCliSession('kimi', kimiKey), 'ses_01')
  assert.equal(rememberedCodexThread(codexKey), 'thr_01')
  assert.equal(continuityArgs(claudeKey)[0], '--resume')
  assert.equal(continuityArgs(claudeKey)[1], sessionUuid(claudeKey))
  assert.equal(firstUnsent(codexKey, fingerprints(messages)), 2)

  forgetBindingsForSession(sessionId)

  assert.equal(rememberedCliSession('kimi', kimiKey), undefined)
  assert.equal(rememberedCodexThread(codexKey), undefined)
  assert.equal(rememberedCliSession('kimi', otherKey), 'ses_keep')
  assert.equal(firstUnsent(codexKey, fingerprints(messages)), 0)
  assert.equal(firstUnsent(kimiKey, fingerprints(messages)), 0)
  const fresh = continuityArgs(claudeKey)
  assert.deepEqual(fresh, ['--session-id', sessionUuid(claudeKey, 1)])
  const handoff = codexTurnPrompt(messages, codexKey, false)
  assert.match(handoff, /first/)
  assert.match(handoff, /conversation-so-far/)
  assert.equal(rememberedCliSession('kimi', otherKey), 'ses_keep')
})

test('updated memory on a restored Codex thread sends the update without replaying old requests or dropping a new image', async () => {
  resetProviderBindingsForTests(join(dir, 'memory-bindings.json'))
  await loadProviderBindings()
  const prior = [
    { role: 'system' as const, content: 'Old preference' },
    { role: 'user' as const, content: 'Old task: deploy' },
    { role: 'assistant' as const, content: 'Done' }
  ]
  rememberCodexThread(codexKey, 'thr_memory')
  rememberSent(codexKey, fingerprints(prior))
  await flushAll()
  resetProviderBindingsForTests(join(dir, 'memory-bindings.json'))
  await loadProviderBindings()
  assert.equal(rememberedCodexThread(codexKey), 'thr_memory')
  const now = [
    { role: 'system' as const, content: 'New preference: only preview' },
    ...prior.slice(1),
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Review the image' }, { type: 'image' as const, data: 'aW1hZ2U=', mime: 'image/png' }] }
  ]
  const prompt = codexTurnPrompt(now, codexKey, true)
  assert.match(prompt, /New preference: only preview/)
  assert.match(prompt, /Review the image/)
  assert.doesNotMatch(prompt, /Old task: deploy/)
  assert.equal(turnImages(now, true).length, 1)
  rememberSent(codexKey, fingerprints(now))
  const next = [...now, { role: 'assistant' as const, content: 'Reviewed' }, { role: 'user' as const, content: 'Next request' }]
  assert.doesNotMatch(codexTurnPrompt(next, codexKey, true), /Old task: deploy|New preference: only preview/)
  assert.match(codexTurnPrompt(next, codexKey, true), /Next request/)
})
