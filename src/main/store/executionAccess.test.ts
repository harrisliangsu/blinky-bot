import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBots, createBot, updateBot, getBot, duplicateBot } from './bots.ts'
import { loadTasks, createTaskRecordDurable, getTask, normaliseTask, storeTaskReviewDurable } from './tasks.ts'
import { flushAll } from './jsonStore.ts'
import { setExecutionAgent, executorAccessSignal, clearExecutionAgent } from '../agent/executionAgent.ts'

test('access persists on the explicit Bot and new task, never migrates into old tasks or copies; revocation stops active execution', async () => {
  const previous = process.env.OPENBOT_DATA_DIR, root = await mkdtemp(join(tmpdir(), 'blinky-access-storage-'))
  process.env.OPENBOT_DATA_DIR = root
  try {
    await loadBots(); await loadTasks()
    const bot = createBot({ backendId: 'codex', modelId: 'm', executionAgent: { backendId: 'codex', modelId: 'worker' } })
    const old = await createTaskRecordDurable(bot.id, 'old-execution', 'Synthetic', 'Old', { sourceSessionId: 'home', executionAgent: { ...bot.executionAgent! } })
    const full = { ...bot.executionAgent!, accessMode: 'full-access' as const }
    updateBot(bot.id, { executionAgent: full })
    const task = await createTaskRecordDurable(bot.id, 'new-execution', 'Synthetic', 'New', { sourceSessionId: 'home', executionAgent: { ...full } })
    assert.equal(duplicateBot(bot.id)?.executionAgent?.accessMode, undefined)
    await flushAll(); await loadBots(); await loadTasks()
    assert.equal(getBot(bot.id)?.executionAgent?.accessMode, 'full-access')
    assert.equal(getTask(task.id)?.executionAgent?.accessMode, 'full-access')
    assert.equal(getTask(old.id)?.executionAgent?.accessMode, undefined)
    const question = { id: 'device', header: '验收', kind: 'preference' as const, question: '先补报告还是等待设备？' }
    await storeTaskReviewDurable(task.id, { outcome: 'blocked', summary: 'Waiting for a device choice', evidence: [], recordedAt: 1, contextKey: 'original-context', question })
    await storeTaskReviewDurable(task.id, { outcome: 'complete_claimed', summary: 'Synthetic review only', evidence: ['synthetic observation'], recordedAt: 2, contextKey: 'answered-context', respondedTo: 'canonical-answer' })
    await flushAll()
    // Exercise the shared JSON boundary: neither integrated feature may erase the other.
    const persisted = normaliseTask(JSON.parse(await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')))
    assert.equal(persisted?.executionAgent?.accessMode, 'full-access')
    assert.equal(persisted?.review?.respondedTo, 'canonical-answer')
    assert.equal(persisted?.review?.contextKey, 'answered-context')
    assert.deepEqual(persisted?.reviewHistory?.[0]?.question, question)
    setExecutionAgent('new-execution', full, bot.id)
    const signal = executorAccessSignal('new-execution')!
    updateBot(bot.id, { executionAgent: { backendId: 'codex', modelId: 'worker' } })
    assert.equal(signal.aborted, true)
    assert.throws(() => updateBot(bot.id, { executionAgent: { backendId: 'pi', modelId: 'worker', accessMode: 'full-access' } }), /does not support/)
    for (const backendId of ['kimi','claude','grok']) { updateBot(bot.id,{executionAgent:{backendId,modelId:'worker',accessMode:'full-access'}});await flushAll();await loadBots();assert.equal(getBot(bot.id)?.executionAgent?.accessMode,'full-access') }
  } finally {
    clearExecutionAgent('new-execution'); await flushAll()
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
