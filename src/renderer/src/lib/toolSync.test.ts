import assert from 'node:assert/strict'
import { test } from 'node:test'
import { entitySyncPlan, groupSkills, mcpServersAfterSync } from './toolSync.ts'

const agents = [
  { botId: 'a', name: 'A', skillIds: ['claude:demo', 'codex:other'], agentsMdIds: ['file-a'] },
  { botId: 'b', name: 'B', skillIds: ['codex:demo'], agentsMdIds: [] },
  { botId: 'c', name: 'C', skillIds: [], agentsMdIds: ['file-c'] }
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

test('base sync adds the baseline assignments and never removes', () => {
  const plan = entitySyncPlan(agents, 'base', 'a')
  assert.deepEqual(plan, [
    { botId: 'b', addSkills: ['claude:demo', 'codex:other'], addAgentsMd: ['file-a'] },
    { botId: 'c', addSkills: ['claude:demo', 'codex:other'], addAgentsMd: ['file-a'] }
  ])
  assert.equal(plan.some((step) => step.botId === 'a'), false)
  assert.equal(plan.some((step) => step.addSkills.includes('codex:demo')), false)
  assert.deepEqual(entitySyncPlan(agents, 'base', 'missing'), [])
})

test('merge sync unions skills and AGENTS.md without dropping anyone', () => {
  const plan = entitySyncPlan(agents, 'merge')
  const byId = Object.fromEntries(plan.map((step) => [step.botId, step]))
  assert.deepEqual(byId.a.addSkills, ['codex:demo'])
  assert.deepEqual(byId.a.addAgentsMd, ['file-c'])
  assert.deepEqual(byId.b.addSkills, ['claude:demo', 'codex:other'])
  assert.deepEqual(byId.b.addAgentsMd, ['file-a', 'file-c'])
  assert.deepEqual(byId.c.addSkills, ['claude:demo', 'codex:other', 'codex:demo'])
  assert.deepEqual(byId.c.addAgentsMd, ['file-a'])
})

test('mcp sync keeps every server enabled flag', () => {
  const servers = [{ id: 'one', enabled: true }, { id: 'two', enabled: false }]
  assert.deepEqual(mcpServersAfterSync(servers), servers)
  assert.equal(mcpServersAfterSync(servers).some((server) => server.id === 'one' && server.enabled === false), false)
})
