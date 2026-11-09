import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTaskRecordDurable, getTask, normaliseTask, recordTaskProgress } from './tasks.ts'
import { flushAll } from './jsonStore.ts'

const progress = { phase: 'running' as const, detail: '正在处理“导出”。', milestones: [{ text: '数据读取完成', at: 123 }], updatedAt: 456 }

test('structured progress survives task normalisation and junk is discarded', () => {
  const raw = { id: 'task', botId: 'bot', sessionId: 'private', status: 'running', title: 't', prompt: 'p', createdAt: 1, updatedAt: 2, progress }
  assert.deepEqual(normaliseTask(raw)?.progress, progress)
  assert.equal(normaliseTask({ ...raw, progress: { phase: 'nonsense', detail: 'x' } })?.progress, undefined)
  assert.equal(normaliseTask({ ...raw, progress: 'running' })?.progress, undefined)
  const blocked = normaliseTask({ ...raw, progress: { ...progress, phase: 'waiting_approval', blocker: '等待你确认。' } })
  assert.equal(blocked?.progress?.blocker, '等待你确认。')
})

test('recordTaskProgress persists changes and no-ops on identical values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-progress-'))
  process.env['OPENBOT_DATA_DIR'] = root
  try {
    const task = await createTaskRecordDurable('bot', 'private', 'work', 'task')
    const saved = await recordTaskProgress(task.id, progress)
    assert.deepEqual(saved?.progress, progress)
    assert.deepEqual(getTask(task.id)?.progress, progress)
    // An identical write (updatedAt aside) must not churn the record.
    const same = await recordTaskProgress(task.id, { ...progress, updatedAt: 999 })
    assert.equal(same?.updatedAt, saved?.updatedAt)
    const changed = await recordTaskProgress(task.id, { ...progress, detail: '正在处理“核验”。', updatedAt: 1000 })
    assert.equal(changed?.progress?.detail, '正在处理“核验”。')
  } finally {
    await flushAll()
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})
