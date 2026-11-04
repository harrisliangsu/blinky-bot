/**
 * The general-purpose seed is Blinky. Only that seed, still named Assistant,
 * is renamed.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateSeededAssistant, SEEDED_ASSISTANT_LINE, SEEDED_GENERAL_BOT_ID } from './starterBots.ts'

const legacyPrompt = `${SEEDED_ASSISTANT_LINE}\n\nBe direct.`

test('the seeded id named Assistant becomes Blinky and the prompt line follows', () => {
  const next = migrateSeededAssistant({
    id: SEEDED_GENERAL_BOT_ID,
    name: 'Assistant',
    systemPrompt: legacyPrompt
  })
  assert.equal(next?.name, 'Blinky')
  assert.match(next?.systemPrompt ?? '', /^You are Blinky, the general-purpose bot/)
  assert.equal(next?.systemPrompt.includes('Assistant'), false)
})

test('a random id is renamed only when it still has the original seed prompt', () => {
  const next = migrateSeededAssistant({
    id: '8f0c1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    name: 'Assistant',
    systemPrompt: legacyPrompt
  })
  assert.equal(next?.name, 'Blinky')
  assert.equal(next?.id, '8f0c1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b')
})

test('a user-named Assistant and a renamed seed stay as the user left them', () => {
  assert.equal(
    migrateSeededAssistant({
      id: 'user-made',
      name: 'Assistant',
      systemPrompt: 'You are Assistant, a bot I wrote myself.'
    }),
    null
  )
  assert.equal(
    migrateSeededAssistant({
      id: SEEDED_GENERAL_BOT_ID,
      name: 'Helper',
      systemPrompt: legacyPrompt
    }),
    null
  )
})
