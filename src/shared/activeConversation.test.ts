import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestChatForBot, planActiveConversations, type BotRef, type ConversationRef } from './activeConversation.ts'

function chat(
  partial: Pick<ConversationRef, 'id' | 'botIds' | 'updatedAt'> & Partial<ConversationRef>
): ConversationRef {
  return { ...partial }
}

test('upgrade picks each bot’s newest open chat and archives the rest', () => {
  const older = chat({ id: 'old', botIds: ['alpha'], updatedAt: 10 })
  const newer = chat({ id: 'new', botIds: ['alpha'], updatedAt: 20 })
  const other = chat({ id: 'beta-home', botIds: ['beta'], updatedAt: 30 })
  const archived = chat({ id: 'gone', botIds: ['alpha'], updatedAt: 40, archived: true })
  const bots: BotRef[] = [{ id: 'alpha' }, { id: 'beta' }]

  const plan = planActiveConversations(bots, [older, newer, other, archived])

  assert.deepEqual(plan.assign, [
    { botId: 'alpha', conversationId: 'new' },
    { botId: 'beta', conversationId: 'beta-home' }
  ])
  assert.deepEqual(plan.archiveIds, ['old'])
  assert.equal(latestChatForBot([older, newer, other, archived], 'alpha')?.id, 'new')
})

test('a stored home is kept and a newer stray chat is archived', () => {
  const home = chat({ id: 'home', botIds: ['alpha'], updatedAt: 5 })
  const stray = chat({ id: 'stray', botIds: ['alpha'], updatedAt: 50 })
  const plan = planActiveConversations([{ id: 'alpha', activeConversationId: 'home' }], [home, stray])
  assert.deepEqual(plan.assign, [])
  assert.deepEqual(plan.archiveIds, ['stray'])
})

test('a stale home is replaced by the newest open chat', () => {
  const archivedHome = chat({ id: 'old-home', botIds: ['alpha'], updatedAt: 1, archived: true })
  const open = chat({ id: 'open', botIds: ['alpha'], updatedAt: 8 })
  const plan = planActiveConversations(
    [{ id: 'alpha', activeConversationId: 'old-home' }],
    [archivedHome, open]
  )
  assert.deepEqual(plan.assign, [{ botId: 'alpha', conversationId: 'open' }])
  assert.deepEqual(plan.archiveIds, [])
})

test('a multi-bot chat stays when it is a home and is archived when it is not', () => {
  const collab = chat({ id: 'collab', botIds: ['alpha', 'beta'], updatedAt: 5 })
  const alphaSolo = chat({ id: 'alpha-solo', botIds: ['alpha'], updatedAt: 10 })
  const betaSolo = chat({ id: 'beta-solo', botIds: ['beta'], updatedAt: 4 })
  const kept = planActiveConversations([{ id: 'alpha' }, { id: 'beta' }], [collab, alphaSolo, betaSolo])
  assert.deepEqual(kept.assign, [
    { botId: 'alpha', conversationId: 'alpha-solo' },
    { botId: 'beta', conversationId: 'collab' }
  ])
  assert.deepEqual(kept.archiveIds, ['beta-solo'])

  const neither = planActiveConversations([{ id: 'alpha' }, { id: 'beta' }], [
    collab,
    alphaSolo,
    chat({ id: 'beta-newer', botIds: ['beta'], updatedAt: 12 })
  ])
  assert.equal(neither.assign.find((row) => row.botId === 'beta')?.conversationId, 'beta-newer')
  assert.ok(neither.archiveIds.includes('collab'))
})

test('equal timestamps keep the first chat', () => {
  const first = chat({ id: 'first', botIds: ['alpha'], updatedAt: 5 })
  const second = chat({ id: 'second', botIds: ['alpha'], updatedAt: 5 })
  assert.equal(latestChatForBot([first, second], 'alpha')?.id, 'first')
  const plan = planActiveConversations([{ id: 'alpha' }], [first, second])
  assert.equal(plan.assign[0]?.conversationId, 'first')
  assert.deepEqual(plan.archiveIds, ['second'])
})
