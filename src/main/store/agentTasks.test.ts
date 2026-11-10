import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cancelAgentTask, createTaskRecord, getTask, loadTasks } from './tasks.ts'
import { flushAll } from './jsonStore.ts'

const root = mkdtempSync(join(tmpdir(), 'blinky-agent-tasks-'))
process.env['OPENBOT_DATA_DIR'] = root
const directory = join(root, 'tasks')
mkdirSync(directory, { recursive: true })
const base = { botId: 'bot', sessionId: 'private-session', sourceSessionId: 'lead-session', title: 'task', prompt: 'work', createdAt: 1, updatedAt: 1 }
for (const task of [
  { ...base, id: 'running', status: 'running' },
  { ...base, id: 'queued', status: 'queued' },
  { ...base, id: 'delivering', status: 'completed', result: 'output', deliveryStatus: 'delivering' },
  { ...base, id: 'pending', status: 'completed', result: 'ready', deliveryStatus: 'pending' }
]) writeFileSync(join(directory, `${task.id}.json`), JSON.stringify(task))

test('restart marks interrupted work and uncertain deliveries without replaying work', async () => {
  await loadTasks()
  for (const id of ['running', 'queued']) {
    const task = getTask(id)!
    assert.equal(task.status, 'failed')
    assert.equal(task.deliveryStatus, 'uncertain')
    assert.match(task.result!, /status is unknown/)
  }
  assert.equal(getTask('delivering')?.deliveryStatus, 'uncertain')
  assert.equal(getTask('pending')?.deliveryStatus, 'pending')
  assert.deepEqual((await flushAll()).failed, [])
  assert.equal(JSON.parse(readFileSync(join(root, 'task-recovery.json'), 'utf8')).entries.delivering.kind, 'delivery')
  // Original task documents survive; the atomic recovery journal is applied
  // by the store until a newer ordinary task write supersedes its base hash.
  assert.equal(JSON.parse(readFileSync(join(directory, 'delivering.json'), 'utf8')).deliveryStatus, 'delivering')
})

test('cancelled independent task keeps cancelled status and a durable result for the lead', async () => {
  const task = createTaskRecord('bot', 'private-session', 'work', 'task', { sourceSessionId: 'lead-session', executionAgent: { backendId: 'codex', modelId: 'default' } })
  const cancelled = cancelAgentTask(task.id)!
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.deliveryStatus, 'uncertain')
  assert.match(cancelled.result!, /Some work may already have occurred/)
  const flushed = await flushAll()
  assert.deepEqual(flushed.failed, [])
  const persisted = JSON.parse(readFileSync(join(directory, `${task.id}.json`), 'utf8'))
  assert.equal(persisted.status, 'cancelled')
  assert.equal(persisted.deliveryStatus, 'uncertain')
})
