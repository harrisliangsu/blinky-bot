import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { confirmClaudeSession, continuityArgs, sessionUuid } from '../backends/cli/claudeSession.ts'
import { rememberCliSession, rememberedCliSession } from '../backends/cli/cliSession.ts'
import { codexTurnPrompt, rememberCodexThread, rememberedCodexThread } from '../backends/cli/codexThread.ts'
import { fingerprints, firstUnsent, rememberSent } from '../backends/cli/resumePrompt.ts'
import { flushAll } from './jsonStore.ts'
import { forgetBindingsForSession, loadProviderBindings, resetProviderBindingsForTests } from './providerBindings.ts'

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
