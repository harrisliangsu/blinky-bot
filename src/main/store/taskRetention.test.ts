import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTaskRecord, createTaskRecordDurable, listTasks, normaliseTask, setTaskStatus, storeTaskReviewDurable, trimTasks } from './tasks.ts'
import { flushAll } from './jsonStore.ts'

test('independent execution history remains reachable past the legacy retention limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-retention-'))
  process.env['OPENBOT_DATA_DIR'] = root
  try {
    for (let i = 0; i < 205; i++) {
      const task = createTaskRecord('bot', `private-${i}`, 'work', `task ${i}`, { sourceSessionId: 'lead', executionAgent: { backendId: 'codex', modelId: 'test' } })
      setTaskStatus(task.id, 'completed')
    }
    trimTasks()
    assert.equal(listTasks().filter((task) => task.sourceSessionId === 'lead').length, 205)
  } finally {
    await flushAll()
    await rm(root, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('a lead assessment is retained on load and invalid assessment states are discarded', () => {
  const raw = { id: 'task', botId: 'bot', sessionId: 'private', status: 'completed', review: { outcome: 'complete_claimed', summary: 'checked', evidence: ['test result'], recordedAt: 123 } }
  assert.deepEqual(normaliseTask(raw)?.review, raw.review)
  assert.equal(normaliseTask({ ...raw, review: { ...raw.review, outcome: 'verified' } })?.review, undefined)
})

test('failed task and review writes do not create phantom records in memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-durable-'))
  try {
    process.env['OPENBOT_DATA_DIR'] = root
    const task = await createTaskRecordDurable('bot', 'private', 'work', 'durable', { sourceSessionId: 'lead', executionAgent: { backendId: 'codex', modelId: 'model' } })
    assert.equal(JSON.parse(await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).title, 'durable')
    await flushAll()
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'fixture')
    process.env['OPENBOT_DATA_DIR'] = blocked
    await assert.rejects(createTaskRecordDurable('bot', 'private', 'work', 'must not exist'))
    await assert.rejects(storeTaskReviewDurable(task.id, { outcome: 'complete_claimed', summary: 'not saved', evidence: ['test'], recordedAt: 1 }))
    assert.ok(!listTasks().some((item) => item.title === 'must not exist'))
    assert.equal(listTasks().find((item) => item.id === task.id)?.review, undefined)
  } finally {
    delete process.env['OPENBOT_DATA_DIR']
    await rm(root, { recursive: true, force: true })
  }
})
