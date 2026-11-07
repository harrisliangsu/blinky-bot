import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBot, loadBots, getBot, updateBot } from './bots.ts'
import { flushAll } from './jsonStore.ts'

test('retired opt-outs migrate once without changing Bot, Agent or conversation data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-bot-executor-'))
  const old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    await mkdir(join(root, 'bots'))
    const bot = { id: 'lead', name: 'Lead', description: 'Keep me', systemPrompt: 'Original instructions', emoji: '🤖', color: '#7c9cff', backendId: 'codex', modelId: 'gpt-test', thinking: 'low', followsDefault: false, tools: ['delegate_task', 'read_file'], skills: ['local:skill'], computerUse: false, computerTarget: { kind: 'local' }, activeConversationId: 'original-home', createdAt: 1, updatedAt: 2 }
    const worker = { backendId: 'kimi', modelId: 'worker-model', thinking: 'high' }
    const fixtures = [
      bot,
      { ...bot, id: 'off', executionAgentDisabled: true },
      { ...bot, id: 'off-null', executionAgentDisabled: true, executionAgent: null },
      { ...bot, id: 'configured-off', executionAgentDisabled: true, executionAgent: worker },
      { ...bot, id: 'configured', executionAgentDisabled: false, executionAgent: worker },
      { ...bot, id: 'no-grant', tools: ['read_file'], executionAgentDisabled: true }
    ]
    for (const fixture of fixtures) await writeFile(join(root, 'bots', `${fixture.id}.json`), JSON.stringify(fixture))
    await loadBots()
    for (const id of ['lead', 'off', 'off-null']) assert.deepEqual(getBot(id)?.executionAgent, { backendId: 'codex', modelId: 'gpt-test', thinking: 'low' })
    for (const id of ['configured', 'configured-off']) assert.deepEqual(getBot(id)?.executionAgent, worker)
    for (const fixture of fixtures) {
      const loaded = getBot(fixture.id)!
      const { executionAgent: _agent, ...unchanged } = loaded
      assert.deepEqual(unchanged, { ...bot, id: fixture.id, tools: fixture.tools })
      const saved = JSON.parse(await readFile(join(root, 'bots', `${fixture.id}.json`), 'utf8'))
      assert.equal(Object.hasOwn(saved, 'executionAgentDisabled'), false)
    }
    assert.equal(getBot('no-grant')?.executionAgent, undefined)
    const changed = updateBot('off', { backendId: 'claude', modelId: 'other-model', thinking: 'max', followsDefault: false })!
    assert.deepEqual(changed.executionAgent, { backendId: 'codex', modelId: 'gpt-test', thinking: 'low' })
    const legacyUpdate = updateBot('configured-off', { executionAgentDisabled: true, name: 'Renamed' })!
    assert.equal(legacyUpdate.executionAgentDisabled, undefined)
    assert.deepEqual(legacyUpdate.executionAgent, worker)
    await flushAll()
    await loadBots()
    assert.deepEqual(getBot('configured-off')?.executionAgent, worker)
    assert.deepEqual(getBot('off')?.executionAgent, changed.executionAgent)
  } finally {
    await flushAll()
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})

test('new Bots ignore the retired flag and preserve independently selected runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-new-executor-'))
  const old = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    await loadBots()
    const bot = createBot({ backendId: 'codex', modelId: 'lead-model', thinking: 'low', followsDefault: false, executionAgentDisabled: true })
    assert.equal(bot.executionAgentDisabled, undefined)
    assert.deepEqual(bot.executionAgent, { backendId: 'codex', modelId: 'lead-model', thinking: 'low' })
    const worker = { backendId: 'kimi', modelId: 'worker-model', thinking: 'high' as const }
    const configured = createBot({ backendId: 'codex', modelId: 'lead-model', thinking: 'low', followsDefault: false, executionAgent: worker })
    assert.deepEqual(configured.executionAgent, worker)
    updateBot(configured.id, { executionAgent: { ...worker, thinking: undefined } })
    assert.equal(getBot(configured.id)?.executionAgent?.thinking, undefined)
    assert.equal(getBot(configured.id)?.thinking, 'low')
    await flushAll()
    await loadBots()
    assert.deepEqual(getBot(configured.id)?.executionAgent, { backendId: 'kimi', modelId: 'worker-model' })
  } finally {
    await flushAll()
    if (old === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = old
    await rm(root, { recursive: true, force: true })
  }
})
