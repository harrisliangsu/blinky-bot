import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { contextForTask, declaredScopeOverlap, parseTaskContext, taskContextInstructions, taskScopeRelations } from './context.ts'
import { parseSavedTaskPlan, parseTaskPlan } from './planning.ts'
import { matchTaskCandidates } from './matching.ts'
import type { AgentTask } from '../../shared/types'

test('matching exposes bounded active consumers across producer continuations, without cross-owner or cross-source leakage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-consumers-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const producer = { id: 'producer', title: 'CSV', botId: 'bot', sourceSessionId: 'source', sessionId: 'producer-exec', status: 'completed', createdAt: 1, updatedAt: 1 } as AgentTask
    const latest = { ...producer, id: 'latest', continuedFromTaskId: producer.id, createdAt: 2 }
    const plan = { priority: 'normal' as const, priorityReason: '', dependencies: [producer.id, latest.id], workspace: 'auto' as const, workspaceReason: '', sourceCwd: '/project', sessionReason: '', context: { summary: 'Read retained CSV', categories: ['export'], scope: ['alpha/output.csv'], boundaries: [] } }
    const consumer = { ...producer, id: 'consumer', title: 'JSON', sessionId: 'consumer-exec', status: 'running' as const, plan, workspace: { strategy: 'directory' as const, path: '/separate-json', sourceCwd: '/project', manifest: '', createdAt: 1 } }
    const ignored = [
      { ...consumer, id: 'completed', status: 'completed' as const },
      { ...consumer, id: 'foreign', botId: 'other' },
      { ...consumer, id: 'other-source', sourceSessionId: 'other-source' },
      { ...consumer, id: 'self', sessionId: producer.sessionId }
    ]
    const consumers = Array.from({ length: 15 }, (_, i) => ({ ...consumer, id: 'consumer-' + i, sessionId: 'consumer-exec-' + i }))
    const runtime = { sessionId: 'source', botId: 'bot', sourceCwd: '/project', executor: false, sessionBusy: () => false, interrupted: () => false }
    const result = matchTaskCandidates([producer, latest, ...consumers, ...ignored], { action: 'match', text: 'Continue CSV validation', limit: 30 }, runtime) as { candidates: Array<{ id: string; activeConsumerCount: number; activeConsumers: Array<{ id: string; scope: string[]; workspacePath?: string }> }> }
    assert.ok(!result.candidates.some(value => value.id === producer.id))
    const facts = result.candidates.find(value => value.id === latest.id)!
    assert.equal(facts.activeConsumerCount, 15, 'multiple attempt dependencies must not duplicate a consumer')
    assert.equal(facts.activeConsumers.length, 12, 'bounded facts keep the MCP response readable')
    assert.deepEqual(facts.activeConsumers[0].scope, ['alpha/output.csv'])
    assert.equal(facts.activeConsumers[0].workspacePath, '/separate-json', 'different directories can still consume prior output')
    assert.ok(facts.activeConsumers.every(value => value.id.startsWith('consumer-')))
    const done = consumers.map(value => ({ ...value, status: 'completed' as const }))
    const refreshed = matchTaskCandidates([producer, latest, ...done], { action: 'match', text: 'Continue after consumers return' }, runtime) as { candidates: Array<{ id: string; activeConsumerCount: number }> }
    assert.equal(refreshed.candidates.find(value => value.id === latest.id)?.activeConsumerCount, 0)
  } finally { if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous; await rm(root, { recursive: true, force: true }) }
})

test('task contexts are small free-form private hints, with legacy compatibility and strict input validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-context-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const raw = { summary: '调整测试环境的导出功能 password=very-private-password', categories: ['数据导出', '自定义领域'], scope: ['src/export', '项目甲 / 测试'], boundaries: ['不发布正式版'] }
    const context = parseTaskContext(raw)
    assert.ok(!context.summary.includes('very-private-password'))
    assert.deepEqual(context.categories, raw.categories)
    const plan = parseTaskPlan({ context: raw }, root, 'source', 'bot', [])
    assert.deepEqual(parseSavedTaskPlan(plan)?.context, context)
    const legacy = { id: 'old', botId: 'bot', sessionId: 'exec', sourceSessionId: 'source', prompt: '历史目标 token=private-test-value', title: 'export', status: 'completed', createdAt: 1, updatedAt: 1 } as AgentTask
    const fallback = contextForTask(legacy)
    assert.equal(fallback.contextSource, 'legacy_excerpt')
    assert.ok(!fallback.context.summary.includes('private-test-value'))
    assert.equal(parseSavedTaskPlan({ ...plan, context: undefined })?.context, undefined)
    assert.throws(() => parseTaskContext({ summary: '' }), /empty/)
    assert.throws(() => parseTaskContext({ summary: 'a'.repeat(1201) }), /long/)
    assert.throws(() => parseTaskContext({ summary: 'goal', categories: Array(7).fill('x') }), /lists/)
    assert.throws(() => parseTaskContext({ summary: 'goal', execute: true }), /Unknown/)
    assert.deepEqual(declaredScopeOverlap(['src/export', 'src/import', '不可并行'], ['src/export/write.ts', '可并行']), ['src/export'])
    const task = { ...legacy, plan }
    const foreign = { ...legacy, id: 'foreign', botId: 'other', plan: { ...plan, context: { ...context, parentTaskId: task.id, summary: 'FOREIGN PRIVATE TASK' } } }
    assert.ok(!taskContextInstructions(task, [task, foreign]).includes('FOREIGN PRIVATE TASK'))
    const child = { ...task, id: 'child', sessionId: 'child-exec', plan: { ...plan, context: { ...context, parentTaskId: task.id } } }
    const continued = { ...task, id: 'continued', continuedFromTaskId: task.id, createdAt: 5 }
    assert.equal(taskScopeRelations(child, [task, child, continued]).parent?.id, continued.id)
    assert.deepEqual(taskScopeRelations(continued, [task, child, continued]).related.map(value => value.id), ['child'])
    const legacyParent = { ...task, plan: undefined, prompt: 'RAW PRIVATE REQUEST FROM ANOTHER EXECUTION' }
    assert.ok(!taskContextInstructions(child, [legacyParent, child]).includes('RAW PRIVATE REQUEST'))
    const longContext = { summary: 's'.repeat(1100), categories: ['custom'], scope: Array.from({ length: 12 }, (_, i) => i + 'x'.repeat(280)), boundaries: Array.from({ length: 8 }, (_, i) => i + 'y'.repeat(280)) }
    const longTasks = Array.from({ length: 35 }, (_, i) => ({ ...legacy, id: 'long-' + i, sessionId: 'long-exec-' + i, plan: { ...plan, context: longContext } }))
    const runtime = { sessionId: 'source', botId: 'bot', sourceCwd: root, executor: false, sessionBusy: () => false, interrupted: () => false }
    const preparing = [{ ...legacy, id: 'preparing', status: 'running' as const }, { ...legacy, id: 'waiting', status: 'queued' as const }]
    const conflicts = matchTaskCandidates(preparing, { action: 'match', text: 'same output directory' }, { ...runtime, workspaceKey: () => 'path:' + root }) as { candidates: Array<{ id: string; sharesWorkspaceWith: string[] }> }
    assert.deepEqual(conflicts.candidates.find(value => value.id === 'waiting')?.sharesWorkspaceWith, ['preparing'])
    let before: string | undefined
    const seen = new Set<string>()
    do {
      const page = matchTaskCandidates(longTasks, { action: 'match', text: 'new goal', limit: 30, before }, runtime) as { candidates: Array<{ id: string }>; next?: string }
      assert.ok(JSON.stringify(page).length < 100000, 'MCP must receive complete bounded JSON')
      assert.ok(page.candidates.length < 30)
      for (const item of page.candidates) { assert.ok(!seen.has(item.id)); seen.add(item.id) }
      before = page.next
    } while (before)
    assert.equal(seen.size, 35)
  } finally { if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous; await rm(root, { recursive: true, force: true }) }
})
