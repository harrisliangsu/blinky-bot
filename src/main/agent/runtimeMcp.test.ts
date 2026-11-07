import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireRuntimeMcpServer } from './runtimeMcp.ts'

test('a supported native CLI must not silently run without the application gateway', () => {
  for (const id of ['codex', 'kimi', 'grok', 'claude', 'opencode']) {
    assert.throws(() => requireRuntimeMcpServer(id, null), /工具网关未能启动/)
    const server = { name: 'fixture' }
    assert.equal(requireRuntimeMcpServer(id, server), server)
  }
  assert.equal(requireRuntimeMcpServer('pi', null), null)
})
