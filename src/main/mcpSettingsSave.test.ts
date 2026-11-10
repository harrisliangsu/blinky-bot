import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rename, mkdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings, updateSettings, saveMcpServer } from './settings.ts'
import { flushAll } from './store/jsonStore.ts'
import type { McpServerConfig } from '../shared/settings.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-mcp-save-'))
process.env.OPENBOT_DATA_DIR = root
const file = join(root, 'settings.json')
const server: McpServerConfig = { id: 'test-mcp', name: 'Original', enabled: false, transport: 'stdio', command: '/usr/bin/false', args: [], env: { KEEP: 'fixture' }, disabledTools: ['keep-tool'] }
test('MCP form acknowledges actual settings write and preserves unrelated state', async () => {
  updateSettings({ theme: 'dark', profileName: 'Keep identity', denylist: ['keep'], mcpServers: [server, { ...server, id: 'other', name: 'Other' }] })
  await flushAll()
  const saved = await saveMcpServer({ server: { ...server, name: 'Saved' }, editingId: server.id })
  const disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.mcpServers[0].name, 'Saved'); assert.equal(disk.mcpServers[0].name, 'Saved')
  assert.equal(disk.profileName, 'Keep identity'); assert.deepEqual(disk.denylist, ['keep']); assert.equal(disk.mcpServers[1].name, 'Other')
  assert.deepEqual(disk.mcpServers[0].env, server.env); assert.deepEqual(disk.mcpServers[0].disabledTools, server.disabledTools)
})
test('failed disk write does not publish; repair permits retry', async () => {
  await rename(file, file + '.saved'); await mkdir(file)
  await assert.rejects(saveMcpServer({ server: { ...server, name: 'Failed' }, editingId: server.id }))
  assert.equal(getSettings().mcpServers[0].name, 'Saved')
  await rmdir(file); await rename(file + '.saved', file)
  await saveMcpServer({ server: { ...server, name: 'Retry' }, editingId: server.id })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers[0].name, 'Retry')
})
test('concurrent ordinary settings and another MCP entry survive form save', async () => {
  const pending = saveMcpServer({ server: { ...server, name: 'Concurrent' }, editingId: server.id })
  await new Promise<void>(resolve => setImmediate(resolve))
  updateSettings({ theme: 'light', mcpServers: getSettings().mcpServers.map(item => item.id === 'other' ? { ...item, name: 'Updated other' } : item) })
  await pending; await flushAll()
  const disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(disk.theme, 'light'); assert.equal(disk.mcpServers[0].name, 'Concurrent'); assert.equal(disk.mcpServers[1].name, 'Updated other')
})
test('a removed connection is not recreated by a stale editor; creating a new entry works', async () => {
  await assert.rejects(saveMcpServer({ server: { ...server, id: 'removed' }, editingId: 'removed' }))
  await saveMcpServer({ server: { ...server, id: 'new', name: 'New' } })
  assert.equal(getSettings().mcpServers.length, 3)
  await assert.rejects(saveMcpServer({ server }))
})
