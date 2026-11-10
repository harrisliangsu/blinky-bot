import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from '../../shared/types'
import { remoteBotCopy, remoteBotCreate, remoteBotPatch } from './botAccess.ts'

const source: Bot = { id: 'synthetic-bot', name: 'Synthetic', description: '', systemPrompt: 'Test', emoji: '✨', color: '#abc', backendId: 'codex', modelId: 'default', tools: ['read_file', 'search_gmail'], computerUse: true, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1 }

test('browser Bot creation cannot grant explicit or default tools or computer use', () => {
  assert.deepEqual(remoteBotCreate({ name: 'New' }), { name: 'New', tools: [], computerUse: false, computerTarget: { kind: 'local' } })
  for (const patch of [{ tools: ['shell'] }, { tools: ['search_gmail'] }, { tools: 'shell' }, { computerUse: true }]) assert.throws(() => remoteBotCreate(patch), { status: 403 })
})

test('browser persona edits preserve current host grants without authorizing additions, removals or computer access', () => {
  assert.deepEqual(remoteBotPatch(source, { name: 'Renamed', tools: [...source.tools], computerUse: true }), { name: 'Renamed' })
  for (const patch of [{ tools: [...source.tools, 'shell'] }, { tools: [] }, { computerUse: false }]) assert.throws(() => remoteBotPatch(source, patch), { status: 403 })
  assert.deepEqual(remoteBotPatch({ ...source, computerUse: false }, { name: 'Ordinary edit' }), { name: 'Ordinary edit' })
})

test('a remote copy reuses persona and model choices without inheriting selected-Bot app or device grants', () => {
  const copy = remoteBotCopy(source)
  assert.deepEqual(copy.tools, []); assert.equal(copy.computerUse, false); assert.deepEqual(copy.computerTarget, { kind: 'local' })
  assert.equal(copy.name, 'Synthetic copy'); assert.equal(copy.systemPrompt, source.systemPrompt); assert.equal(copy.backendId, source.backendId)
})
