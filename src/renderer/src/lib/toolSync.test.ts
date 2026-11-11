import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentsMdIdsForTurn, localCliAgentsMdMigration } from '../../../shared/localCliTools.ts'
import { entitySyncPlan, groupSkills, mcpServersAfterSync } from './toolSync.ts'

const clis = [
  { id: 'codex', name: 'Codex', agentsMdIds: ['file-a'] },
  { id: 'kimi', name: 'Kimi Code', agentsMdIds: [] },
  { id: 'claude', name: 'Claude Code', agentsMdIds: ['file-c'] }
]

test('skills group by name and keep every source', () => {
  const grouped = groupSkills([
    { id: 'claude:demo', name: 'demo', origin: 'claude', description: 'short', path: '/claude' },
    { id: 'codex:demo', name: 'demo', origin: 'codex', description: 'a longer description', path: '/codex' },
    { id: 'grok:notes', name: 'notes', origin: 'grok', description: '', path: '/grok' }
  ])
  assert.equal(grouped.length, 2)
  assert.deepEqual(grouped[0].sources.map((item) => item.origin), ['claude', 'codex'])
  assert.equal(grouped[0].description, 'a longer description')
  assert.equal(grouped[1].name, 'notes')
})

test('base sync copies one local CLI and never removes', () => {
  const plan = entitySyncPlan(clis, 'base', 'codex')
  assert.deepEqual(plan, [
    { id: 'kimi', addAgentsMd: ['file-a'] },
    { id: 'claude', addAgentsMd: ['file-a'] }
  ])
  assert.equal(plan.some((step) => step.id === 'codex'), false)
  assert.deepEqual(entitySyncPlan(clis, 'base', 'missing'), [])
})

test('merge sync unions AGENTS.md across local CLIs', () => {
  const plan = entitySyncPlan(clis, 'merge')
  const byId = Object.fromEntries(plan.map((step) => [step.id, step]))
  assert.deepEqual(byId.codex.addAgentsMd, ['file-c'])
  assert.deepEqual(byId.kimi.addAgentsMd, ['file-a', 'file-c'])
  assert.deepEqual(byId.claude.addAgentsMd, ['file-a'])
})

test('Bot AGENTS.md assignments move onto the local CLIs that Bot runs', () => {
  const moved = localCliAgentsMdMigration({}, [
    { id: 'developer', backendId: 'openai', executionAgent: { backendId: 'codex' }, agentsMdIds: ['from-bot'] },
    { id: 'provider-only', backendId: 'openai', agentsMdIds: ['stay'] }
  ])
  assert.deepEqual(moved.next.codex, ['from-bot'])
  assert.deepEqual(moved.clearBotIds, ['developer'])
  const turn = agentsMdIdsForTurn({ backendId: 'codex', agentsMdIds: ['from-bot'] }, { localCliAgentsMd: moved.next })
  assert.deepEqual(turn, ['from-bot'])
  assert.deepEqual(agentsMdIdsForTurn({ backendId: 'openai', agentsMdIds: ['stay'] }, { localCliAgentsMd: moved.next }), ['stay'])
})

test('mcp sync keeps every server enabled flag', () => {
  const servers = [{ id: 'one', enabled: true }, { id: 'two', enabled: false }]
  assert.deepEqual(mcpServersAfterSync(servers), servers)
  assert.equal(mcpServersAfterSync(servers).some((server) => server.id === 'one' && server.enabled === false), false)
})
