import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recordTaskOutcome } from './taskOutcomes'
import { createTaskRecordDurable, setTaskStatus } from '../store/tasks'
import { parseTaskPlan } from './planning'

const root = (): string => process.env['OPENBOT_DATA_DIR'] as string
const mk = (id: string, title: string) => ({
  id, botId: 'bot', sessionId: 'exec-' + id, title, prompt: 'p', status: 'running' as const, createdAt: Date.now() - 5000, updatedAt: Date.now(),
  plan: parseTaskPlan({ context: { summary: 'p', categories: ['功能开发'], scope: ['src/export'], boundaries: ['不发布'] } }, root(), 'home', 'bot', [])
})

test('terminal tasks append one bounded outcome record; duplicates are ignored', async () => {
  process.env['OPENBOT_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'blinky-outcomes-'))
  try {
    const task = mk('t-1', '报表导出')
    await recordTaskOutcome({ ...task, status: 'completed' })
    await recordTaskOutcome({ ...task, status: 'completed' })
    const { readJsonState } = await import('../store/jsonStore')
    const read = await readJsonState(join(root(), 'task-outcomes.json'), null)
    const entries = (read.value as unknown as { entries: unknown[] }).entries
    assert.equal(entries.length, 1)
    const record = entries[0] as unknown as Record<string, number>
    assert.equal(record.outcome, 'completed')
    assert.deepEqual(record.plannedScope, ['src/export'])
    assert.equal(record.durationMs >= 0, true)
  } finally {
    await rm(process.env['OPENBOT_DATA_DIR'] as string, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('a blocked review turns a completed status into a blocked outcome', async () => {
  process.env['OPENBOT_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'blinky-outcomes2-'))
  try {
    await recordTaskOutcome({ ...mk('t-2', '设备验收'), status: 'completed', review: { outcome: 'blocked', summary: '缺真实设备证据', evidence: ['mock only'], recordedAt: Date.now() } })
    const { readJsonState } = await import('../store/jsonStore')
    const read = await readJsonState(join(root(), 'task-outcomes.json'), null)
    assert.equal((read.value as unknown as { entries: Array<{ outcome: string }> }).entries[0].outcome, 'blocked')
  } finally {
    await rm(process.env['OPENBOT_DATA_DIR'] as string, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('setTaskStatus drives outcome recording for completed and failed tasks', async () => {
  process.env['OPENBOT_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'blinky-outcomes3-'))
  try {
    const a = await createTaskRecordDurable('bot', 'exec-a', 'work', '任务A', { plan: parseTaskPlan({ context: { summary: 's', categories: [], scope: ['src/a'], boundaries: [] } }, root(), 'home', 'bot', []) })
    const b = await createTaskRecordDurable('bot', 'exec-b', 'work', '任务B', { plan: parseTaskPlan({ context: { summary: 's', categories: [], scope: ['src/b'], boundaries: [] } }, root(), 'home', 'bot', []) })
    setTaskStatus(a.id, 'completed')
    setTaskStatus(b.id, 'failed', '连接被拒')
    const { readJsonState } = await import('../store/jsonStore')
    let entries: Array<{ taskId: string; outcome: string; error?: string }> = []
    for (let attempt = 0; attempt < 40 && entries.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const read = await readJsonState(join(root(), 'task-outcomes.json'), null)
      entries = (read.value as unknown as { entries: Array<{ taskId: string; outcome: string; error?: string }> }).entries ?? []
    }
    assert.equal(entries.length, 2)
    assert.equal(entries.find((e) => e.taskId === a.id)?.outcome, 'completed')
    assert.equal(entries.find((e) => e.taskId === b.id)?.error, '连接被拒')
  } finally {
    await rm(process.env['OPENBOT_DATA_DIR'] as string, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})
