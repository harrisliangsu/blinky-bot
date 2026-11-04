import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types'
import { latestChatForBot } from './botChat.ts'

function chat(partial: Pick<SessionSummary, 'id' | 'botIds' | 'updatedAt'> & Partial<SessionSummary>): SessionSummary {
  return {
    title: 'New Chat',
    messageCount: 0,
    ...partial
  }
}

test('a bot click resolves to that bot’s newest open conversation', () => {
  const older = chat({ id: 'old', botIds: ['alpha'], updatedAt: 10, messageCount: 4 })
  const newer = chat({ id: 'new', botIds: ['alpha', 'beta'], updatedAt: 20, messageCount: 1 })
  const other = chat({ id: 'other', botIds: ['beta'], updatedAt: 30, messageCount: 2 })
  const archived = chat({ id: 'gone', botIds: ['alpha'], updatedAt: 40, archived: true, messageCount: 9 })

  assert.equal(latestChatForBot([older, newer, other, archived], 'alpha')?.id, 'new')
  assert.equal(latestChatForBot([older, newer, other, archived], 'beta')?.id, 'other')
  assert.equal(latestChatForBot([older, newer, other, archived], 'missing'), null)
})

test('equal timestamps keep the first match', () => {
  const first = chat({ id: 'first', botIds: ['alpha'], updatedAt: 5 })
  const second = chat({ id: 'second', botIds: ['alpha'], updatedAt: 5 })
  assert.equal(latestChatForBot([first, second], 'alpha')?.id, 'first')
})
