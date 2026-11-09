import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOOL_GROUPS, groupOfTool, toolConsistency, toolSyncPlan } from './toolSync'

test('every registered tool id belongs to exactly one sync group', async () => {
  const { TOOL_IDS } = await import('../../../shared/tools.ts')
  for (const id of TOOL_IDS) {
    assert.ok(groupOfTool(id), `ungrouped tool: ${id}`)
  }
  const total = TOOL_GROUPS.reduce((n, group) => n + group.ids.length, 0)
  assert.equal(total, new Set(TOOL_GROUPS.flatMap((group) => group.ids)).size)
})

test('consistency flags any Agent that lacks the tool', () => {
  const cells = [
    { botId: 'a', name: 'A', state: 'on' as const },
    { botId: 'b', name: 'B', state: 'on' as const },
    { botId: 'c', name: 'C', state: 'off' as const }
  ]
  assert.deepEqual(toolConsistency(cells), { consistent: false, off: 1 })
  assert.deepEqual(toolConsistency(cells.map((cell) => ({ ...cell, state: 'on' as const }))), { consistent: true, off: 0 })
})

test('sync plan is add-only and never touches the baseline', () => {
  const cells = [
    { botId: 'a', name: 'A', state: 'on' as const },
    { botId: 'b', name: 'B', state: 'off' as const },
    { botId: 'c', name: 'C', state: 'on' as const }
  ]
  const plan = toolSyncPlan(cells, 'a', 'shell', ['shell', 'fetch'])
  assert.deepEqual(plan, [{ botId: 'b', add: ['shell'] }])
  // Baseline lacking the tool means nobody gains it.
  assert.deepEqual(toolSyncPlan(cells, 'b', 'shell', ['fetch']), [])
  // A baseline without the tool never causes removals.
  assert.deepEqual(toolSyncPlan(cells, 'b', 'shell', ['fetch']).some((step) => step.add.includes('fetch')), false)
})
