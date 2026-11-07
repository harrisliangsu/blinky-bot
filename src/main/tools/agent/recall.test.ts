import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolContext } from '../types'
import { recallTool } from './recall'

const context = (host?: ToolContext['host']): ToolContext => ({ botId: 'current-bot', sessionId: 'current-session', cwd: '/isolated', signal: new AbortController().signal, emit() {}, requestApproval: async () => { throw Error('A read should not request approval') }, host })

test('recall uses only the invoking Bot identity and propagates a bounded explicit search', async () => {
  let seen: unknown
  const result = await recallTool.handler({ query: 'older project', kind: 'journal', limit: 3, botId: 'other-bot' }, context({ recallMemory: (botId, query, kind, limit) => { seen = { botId, query, kind, limit }; return [{ id: 'old', botId, text: 'Older project facts', source: 'user', createdAt: 1, tags: ['journal'] }] } }))
  assert.ok(result.ok)
  assert.deepEqual(seen, { botId: 'current-bot', query: 'older project', kind: 'journal', limit: 3 })
  assert.equal(JSON.parse(result.output)[0].createdAt, 1)
})

test('no host, invalid limits/kinds, cancellation and failed reads never fabricate recall success', async () => {
  assert.equal((await recallTool.handler({ query: 'something' }, context())).ok, false)
  let reads = 0
  const ctx = context({ recallMemory: () => { reads++; return [] } })
  for (const args of [{ query: ' ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', limit: 1.5 }, { query: 'x', kind: 'foreign' }]) assert.equal((await recallTool.handler(args, ctx)).ok, false)
  assert.equal(reads, 0)
  const controller = new AbortController(); controller.abort()
  assert.equal((await recallTool.handler({ query: 'x' }, { ...ctx, signal: controller.signal })).ok, false)
  assert.equal(reads, 0)
  assert.equal((await recallTool.handler({ query: 'x' }, context({ recallMemory: async () => { throw Error('Synthetic read failed') } }))).ok, false)
})
