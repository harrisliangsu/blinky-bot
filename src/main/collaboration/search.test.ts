import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publicRemoteData, publicRemoteMessage } from './publicData.ts'

test('remote search reuses ranking but cannot return tool, reasoning, internal messages or host attachment paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-remote-search-')), before = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const { loadSessions, saveSession } = await import('../store/sessions.ts')
    const { searchAll } = await import('../search.ts')
    const { createBot } = await import('../store/bots.ts')
    await loadSessions()
    saveSession({ id: 'search-session', title: 'Synthetic', cwd: root, mode: 'ask', botIds: ['bot'], activeBotId: 'bot', todos: [], createdAt: 1, updatedAt: 1, messages: [
      { id: 'u', role: 'user', content: 'public-findable', createdAt: 1, attachments: [{ id: 'a', kind: 'file', name: 'visible.txt', path: '/private-host-file-path' }] },
      { id: 't', role: 'tool', content: 'private-tool-value', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'public answer', reasoning: 'private-reasoning-value', createdAt: 1 },
      { id: 'h', role: 'assistant', content: 'private-internal-value', internal: true, createdAt: 1 }
      ,{ id: 'secret', role: 'user', content: 'password=synthetic-search-password', createdAt: 1 }
    ] })
    createBot({ name: 'Synthetic metadata', description: 'password=synthetic-metadata-password' })
    assert.ok(searchAll('private-tool').length > 0, 'desktop search retains its existing contract')
    for (const query of ['private-tool', 'private-reasoning', 'private-internal', 'private-host-file']) assert.deepEqual(searchAll(query, 50, false, publicRemoteMessage), [])
    assert.equal(searchAll('public-findable', 50, false, publicRemoteMessage)[0]?.kind, 'message')
    const file = searchAll('visible.txt', 50, false, publicRemoteMessage)[0]
    assert.equal(file?.kind, 'file'); assert.ok(!JSON.stringify(file).includes('/private-host'))
    const remote = (query: string) => searchAll(query, 50, false, publicRemoteMessage, value => publicRemoteData({ value }).value)
    assert.deepEqual(remote('synthetic-search-password'), [], 'redacted content must not act as an existence oracle')
    assert.deepEqual(remote('synthetic-metadata-password'), [], 'Bot metadata must be projected before matching too')
    assert.equal(remote('public-findable')[0]?.kind, 'message')
  } finally { if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before; await rm(root, { recursive: true, force: true }) }
})
